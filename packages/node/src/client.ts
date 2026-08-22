import { gzip } from "node:zlib";

import {
  TrafficWarApiError,
  TrafficWarConnectionError,
  TrafficWarProtocolError,
  TrafficWarRateLimitError,
  TrafficWarValidationError,
} from "./errors";
import type {
  CompressionMode,
  FlushResult,
  IngestResult,
  TrafficWarEvent,
  TrafficWarErrorHandler,
  TrafficWarFetch,
  TrafficWarOptions,
} from "./types";
import {
  normalizeEvent,
  serializeJson,
  type NormalizedEvent,
} from "./validation";
import { uuidv7 } from "./uuidv7";
import packageMetadata from "../package.json" with { type: "json" };

export const TRAFFICWAR_DEFAULT_BASE_URL = "https://ingest.trafficwar.tech";
export const TRAFFICWAR_DEFAULT_TIMEOUT_MS = 30_000;
export const TRAFFICWAR_DEFAULT_MAX_RETRIES = 3;
export const TRAFFICWAR_DEFAULT_FLUSH_INTERVAL_MS = 1_000;
export const TRAFFICWAR_DEFAULT_MAX_QUEUE_SIZE = 100_000;
export const TRAFFICWAR_MAX_BATCH_SIZE = 10_000;
export const TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES = 2 * 1024 * 1024;
export const TRAFFICWAR_MAX_DECODED_BODY_BYTES = 8 * 1024 * 1024;

const SDK_VERSION = packageMetadata.version;
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024;
const RETRYABLE_STATUSES = new Set([408, 425, 500, 502, 503, 504]);
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 10_000;
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_TIMER_MS = 2_147_483_647;

interface PreparedRequest {
  body: Uint8Array;
  contentEncoding: "gzip" | undefined;
}

interface PreparedBatch extends PreparedRequest {
  events: readonly NormalizedEvent[];
  idempotencyKey: string;
}

interface ParsedBody {
  text: string;
  value: unknown;
  isJson: boolean;
}

interface AttemptResult {
  response: Response;
  text: string;
}

class AttemptTransportFailure {
  readonly cause: unknown;
  readonly timedOut: boolean;

  constructor(cause: unknown, timedOut: boolean) {
    this.cause = cause;
    this.timedOut = timedOut;
  }
}

class PreparedRequestTooLarge extends Error {
  readonly limit: "decoded" | "wire";

  constructor(limit: "decoded" | "wire") {
    super(limit);
    this.limit = limit;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string | URL | undefined): string {
  const candidate = value ?? TRAFFICWAR_DEFAULT_BASE_URL;
  if (typeof candidate !== "string" && !(candidate instanceof URL)) {
    throw new TrafficWarValidationError(
      "baseUrl must be an HTTP or HTTPS URL",
      { path: "options.baseUrl" },
    );
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch (cause) {
    throw new TrafficWarValidationError(
      "baseUrl must be a valid HTTP or HTTPS URL",
      { path: "options.baseUrl", cause },
    );
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.pathname.replaceAll("/", "").length > 0
  ) {
    throw new TrafficWarValidationError(
      "baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment",
      { path: "options.baseUrl" },
    );
  }

  return url.origin;
}

function validateApiKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new TrafficWarValidationError(
      "apiKey must be a non-empty visible ASCII string",
      { path: "options.apiKey" },
    );
  }
  return value;
}

function validateIntegerOption(
  name: string,
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const actual = value ?? fallback;
  if (
    typeof actual !== "number" ||
    !Number.isSafeInteger(actual) ||
    actual < minimum ||
    actual > maximum
  ) {
    throw new TrafficWarValidationError(
      `${name} must be an integer from ${minimum} to ${maximum}`,
      { path: `options.${name}` },
    );
  }
  return actual;
}

function validateBooleanOption(
  name: string,
  value: unknown,
  fallback: boolean,
): boolean {
  const actual = value ?? fallback;
  if (typeof actual !== "boolean") {
    throw new TrafficWarValidationError(
      `${name} must be a boolean`,
      { path: `options.${name}` },
    );
  }
  return actual;
}

function validateCompression(value: unknown): CompressionMode {
  const actual = value ?? "auto";
  if (actual !== "auto" && actual !== "gzip" && actual !== "none") {
    throw new TrafficWarValidationError(
      "compression must be auto, gzip, or none",
      { path: "options.compression" },
    );
  }
  return actual;
}

function parseBody(text: string): ParsedBody {
  if (text.length === 0) {
    return { text, value: undefined, isJson: false };
  }
  try {
    return { text, value: JSON.parse(text), isJson: true };
  } catch {
    return { text, value: undefined, isJson: false };
  }
}

function bodyRetryAfterSeconds(value: unknown): number | undefined {
  const details = asRecord(value);
  const seconds = finiteNumber(details?.retry_after_secs);
  return seconds !== undefined && seconds >= 0 ? seconds : undefined;
}

function headerRetryAfterSeconds(
  headers: Headers,
  nowMs: number,
): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }

  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) {
    return undefined;
  }
  return Math.max(0, (dateMs - nowMs) / 1000);
}

function retryAfterSeconds(
  response: Response,
  parsed: ParsedBody,
): number | undefined {
  return (
    headerRetryAfterSeconds(response.headers, Date.now()) ??
    bodyRetryAfterSeconds(parsed.value)
  );
}

function retryDelayMs(retryIndex: number, retryAfter: number | undefined): number {
  const exponential = Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** Math.min(retryIndex, 20),
  );
  const jitter = Math.random() * exponential;
  return Math.max(jitter, (retryAfter ?? 0) * 1000);
}

async function sleepChunk(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let remaining = Math.max(0, Math.ceil(ms));
  if (remaining === 0) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    return;
  }
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_TIMER_MS);
    await sleepChunk(chunk, signal);
    remaining -= chunk;
  }
}

async function executeAttempt(
  fetcher: TrafficWarFetch,
  url: string,
  init: RequestInit,
  userSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutReason = new Error(
    `TrafficWar request timed out after ${timeoutMs} ms`,
  );
  const onUserAbort = (): void => {
    controller.abort(userSignal?.reason);
  };

  if (userSignal?.aborted) {
    controller.abort(userSignal.reason);
  } else {
    userSignal?.addEventListener("abort", onUserAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutReason);
  }, timeoutMs);

  let onAttemptAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAttemptAbort = (): void => reject(controller.signal.reason);
    if (controller.signal.aborted) {
      onAttemptAbort();
    } else {
      controller.signal.addEventListener("abort", onAttemptAbort, {
        once: true,
      });
    }
  });

  try {
    const request = (async (): Promise<AttemptResult> => {
      const response = await fetcher(url, {
        ...init,
        signal: controller.signal,
      });
      const text = await response.text();
      return { response, text };
    })();
    return await Promise.race([request, abortPromise]);
  } catch (cause) {
    throw new AttemptTransportFailure(cause, timedOut);
  } finally {
    clearTimeout(timer);
    userSignal?.removeEventListener("abort", onUserAbort);
    if (onAttemptAbort) {
      controller.signal.removeEventListener("abort", onAttemptAbort);
    }
  }
}

function gzipBody(decoded: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(decoded, (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

async function prepareRequest(
  payload: unknown,
  idempotencyKey: string,
  compression: CompressionMode,
  compressionThresholdBytes: number,
): Promise<PreparedRequest> {
  const decoded = serializeJson(payload, idempotencyKey);
  if (decoded.byteLength > TRAFFICWAR_MAX_DECODED_BODY_BYTES) {
    throw new PreparedRequestTooLarge("decoded");
  }

  const useGzip =
    compression === "gzip" ||
    (compression === "auto" &&
      decoded.byteLength >= compressionThresholdBytes);
  let body: Uint8Array;
  try {
    body = useGzip ? await gzipBody(decoded) : decoded;
  } catch (cause) {
    throw new TrafficWarValidationError("Unable to gzip request body", {
      path: "body",
      idempotencyKey,
      cause,
    });
  }

  if (body.byteLength > TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES) {
    throw new PreparedRequestTooLarge("wire");
  }

  return {
    body,
    contentEncoding: useGzip ? "gzip" : undefined,
  };
}

function buildApiError(
  response: Response,
  parsed: ParsedBody,
  idempotencyKey: string,
): TrafficWarApiError {
  const details = parsed.isJson ? parsed.value : undefined;
  const record = asRecord(details);
  const retryAfter = retryAfterSeconds(response, parsed);
  const ingestId = nonEmptyString(record?.ingest_id);
  const status = nonEmptyString(record?.status);
  const message = nonEmptyString(record?.error);

  if (
    !parsed.isJson ||
    record === undefined ||
    (status !== "error" && status !== "pending") ||
    message === undefined
  ) {
    throw new TrafficWarProtocolError(
      "TrafficWar returned an invalid error response",
      {
        status: response.status,
        details,
        retryAfterSeconds: retryAfter,
        ingestId,
        idempotencyKey,
        responseBody: parsed.text,
      },
    );
  }

  if (response.status === 429) {
    return new TrafficWarRateLimitError(message, {
      status: response.status,
      details,
      retryAfterSeconds: retryAfter,
      ingestId,
      idempotencyKey,
      period: nonEmptyString(record?.period),
      used: finiteNumber(record?.used),
      limit: finiteNumber(record?.limit),
      remainingEvents: finiteNumber(record?.remaining_events),
      batchEvents: finiteNumber(record?.batch_events),
      retryAfterSecs: bodyRetryAfterSeconds(details),
    });
  }

  return new TrafficWarApiError(message, {
    status: response.status,
    details,
    retryAfterSeconds: retryAfter,
    ingestId,
    idempotencyKey,
  });
}

function parseSuccess(
  response: Response,
  parsed: ParsedBody,
  expectedCount: number,
  idempotencyKey: string,
): IngestResult {
  const record = asRecord(parsed.value);
  const accepted = finiteNumber(record?.accepted);
  const ingestId = nonEmptyString(record?.ingest_id);

  if (
    !parsed.isJson ||
    record?.status !== "ok" ||
    accepted === undefined ||
    !Number.isSafeInteger(accepted) ||
    accepted < 0 ||
    accepted !== expectedCount ||
    ingestId === undefined
  ) {
    throw new TrafficWarProtocolError(
      "TrafficWar returned an invalid success response",
      {
        status: response.status,
        details: parsed.isJson ? parsed.value : undefined,
        retryAfterSeconds: retryAfterSeconds(response, parsed),
        ingestId,
        idempotencyKey,
        responseBody: parsed.text,
      },
    );
  }

  return {
    status: "ok",
    accepted,
    ingestId,
    idempotencyKey,
  };
}

export class TrafficWar {
  readonly baseUrl: string;
  readonly debug: boolean;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly compression: CompressionMode;
  readonly compressionThresholdBytes: number;
  readonly flushIntervalMs: number;
  readonly maxQueueSize: number;

  readonly #apiKey: string;
  readonly #fetch: TrafficWarFetch;
  readonly #onError: TrafficWarErrorHandler | undefined;

  readonly #queue: NormalizedEvent[] = [];
  readonly #pendingEventIds = new Set<string>();
  #pendingCount = 0;
  #preparedBatch: PreparedBatch | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #drainPromise: Promise<FlushResult> | undefined;
  #backgroundPromise: Promise<FlushResult> | undefined;
  #backgroundScheduled = false;
  #closePromise: Promise<FlushResult> | undefined;
  #closing = false;
  #closed = false;

  constructor(options: TrafficWarOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      Array.isArray(options)
    ) {
      throw new TrafficWarValidationError(
        "TrafficWar options must be an object",
        { path: "options" },
      );
    }

    this.#apiKey = validateApiKey(options.apiKey);
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.debug = validateBooleanOption("debug", options.debug, false);
    this.timeoutMs = validateIntegerOption(
      "timeoutMs",
      options.timeoutMs,
      TRAFFICWAR_DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMER_MS,
    );
    this.maxRetries = validateIntegerOption(
      "maxRetries",
      options.maxRetries,
      TRAFFICWAR_DEFAULT_MAX_RETRIES,
      0,
      100,
    );
    this.compression = validateCompression(options.compression);
    this.compressionThresholdBytes = validateIntegerOption(
      "compressionThresholdBytes",
      options.compressionThresholdBytes,
      DEFAULT_COMPRESSION_THRESHOLD_BYTES,
      0,
      TRAFFICWAR_MAX_DECODED_BODY_BYTES,
    );
    this.flushIntervalMs = validateIntegerOption(
      "flushIntervalMs",
      options.flushIntervalMs,
      TRAFFICWAR_DEFAULT_FLUSH_INTERVAL_MS,
      1,
      MAX_TIMER_MS,
    );
    this.maxQueueSize = validateIntegerOption(
      "maxQueueSize",
      options.maxQueueSize,
      TRAFFICWAR_DEFAULT_MAX_QUEUE_SIZE,
      1,
      Number.MAX_SAFE_INTEGER,
    );
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new TrafficWarValidationError(
        "fetch must be a function",
        { path: "options.fetch" },
      );
    }
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new TrafficWarValidationError(
        "onError must be a function",
        { path: "options.onError" },
      );
    }
    this.#fetch =
      options.fetch ??
      ((input, init) => {
        return globalThis.fetch(input, init);
      });
    this.#onError = options.onError;
    this.#debugLog("client initialized", {
      baseUrl: this.baseUrl,
      compression: this.compression,
      flushIntervalMs: this.flushIntervalMs,
      maxQueueSize: this.maxQueueSize,
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
    });
  }

  #debugLog(message: string, details: Record<string, unknown>): void {
    if (!this.debug) {
      return;
    }
    try {
      console.debug(`[TrafficWar] ${message}`, details);
    } catch {
      // Diagnostics must never affect capture or delivery.
    }
  }

  capture(
    eventOrEvents: TrafficWarEvent | readonly TrafficWarEvent[],
  ): void {
    if (this.#closed) {
      throw new TrafficWarValidationError(
        "TrafficWar client is closed",
        { path: "client" },
      );
    }
    if (this.#closing) {
      throw new TrafficWarValidationError(
        "TrafficWar client is closing",
        { path: "client" },
      );
    }

    const isBatch = Array.isArray(eventOrEvents);
    if (isBatch && eventOrEvents.length === 0) {
      throw new TrafficWarValidationError(
        "events must be a non-empty array",
        { path: "events" },
      );
    }
    const events = isBatch ? eventOrEvents : [eventOrEvents];
    if (isBatch) {
      for (let index = 0; index < events.length; index += 1) {
        if (!(index in events)) {
          const path = `events[${index}]`;
          throw new TrafficWarValidationError(
            `${path} is missing; sparse event arrays are not supported`,
            { path },
          );
        }
      }
    }
    if (events.length > this.maxQueueSize - this.#pendingCount) {
      throw new TrafficWarValidationError(
        `TrafficWar queue cannot exceed ${this.maxQueueSize} events`,
        { path: "queue" },
      );
    }

    const normalized: NormalizedEvent[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const path = isBatch ? `events[${index}]` : "event";
      normalized.push(normalizeEvent(events[index]!, path));
    }

    for (const event of normalized) {
      if (!Object.hasOwn(event, "event_id")) {
        event.event_id = uuidv7();
      }
    }

    const incomingEventIds = new Set<string>();
    for (let index = 0; index < normalized.length; index += 1) {
      const eventId = normalized[index]!.event_id as string;
      if (
        incomingEventIds.has(eventId) ||
        this.#pendingEventIds.has(eventId)
      ) {
        const path = isBatch
          ? `events[${index}].event_id`
          : "event.event_id";
        throw new TrafficWarValidationError(
          `${path} duplicates an unacknowledged event_id`,
          { path },
        );
      }
      incomingEventIds.add(eventId);
    }

    for (const event of normalized) {
      this.#queue.push(event);
      this.#pendingEventIds.add(event.event_id as string);
    }
    this.#pendingCount += normalized.length;
    this.#debugLog("events queued", {
      added: normalized.length,
      pending: this.#pendingCount,
    });
    if (this.#pendingCount >= TRAFFICWAR_MAX_BATCH_SIZE) {
      this.#clearTimer();
      this.#debugLog("automatic flush triggered", {
        pending: this.#pendingCount,
        reason: "batch-size",
      });
      this.#startBackgroundDrain();
    } else {
      this.#ensureTimer();
    }
  }

  /**
   * @deprecated Pass the array directly to capture().
   */
  captureBatch(events: readonly TrafficWarEvent[]): void {
    if (!Array.isArray(events) || events.length === 0) {
      throw new TrafficWarValidationError(
        "events must be a non-empty array",
        { path: "events" },
      );
    }
    this.capture(events);
  }

  flush(): Promise<FlushResult> {
    this.#debugLog("manual flush requested", {
      pending: this.#pendingCount,
    });
    if (this.#closePromise) {
      return this.#closePromise;
    }
    this.#clearTimer();
    return this.#startDrain();
  }

  close(): Promise<FlushResult> {
    if (this.#closed) {
      return Promise.resolve({ accepted: 0, batches: [] });
    }
    if (this.#closePromise) {
      return this.#closePromise;
    }

    this.#debugLog("close requested", {
      pending: this.#pendingCount,
    });
    this.#clearTimer();
    this.#closing = true;
    let closing!: Promise<FlushResult>;
    closing = Promise.resolve().then(async () => {
      const batches: IngestResult[] = [];
      let accepted = 0;
      try {
        do {
          const result = await this.#startDrain();
          accepted += result.accepted;
          for (const batch of result.batches) {
            batches.push(batch);
          }
        } while (this.#pendingCount > 0);

        this.#clearTimer();
        this.#closed = true;
        this.#debugLog("client closed", {
          accepted,
          batches: batches.length,
        });
        return { accepted, batches };
      } finally {
        if (this.#closePromise === closing) {
          this.#closePromise = undefined;
        }
        this.#closing = false;
        if (!this.#closed && this.#pendingCount > 0) {
          this.#ensureTimer();
        }
      }
    });
    this.#closePromise = closing;
    return closing;
  }

  #ensureTimer(): void {
    if (
      this.#closed ||
      this.#closing ||
      this.#pendingCount === 0 ||
      this.#timer !== undefined
    ) {
      return;
    }

    const timer = setTimeout(() => {
      if (this.#timer === timer) {
        this.#timer = undefined;
      }
      this.#debugLog("automatic flush triggered", {
        pending: this.#pendingCount,
        reason: "interval",
      });
      this.#startBackgroundDrain();
    }, this.flushIntervalMs);
    timer.unref();
    this.#timer = timer;
    this.#debugLog("flush timer scheduled", {
      delayMs: this.flushIntervalMs,
      pending: this.#pendingCount,
    });
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #startBackgroundDrain(): void {
    if (this.#backgroundScheduled) {
      return;
    }
    this.#backgroundScheduled = true;
    queueMicrotask(() => {
      this.#backgroundScheduled = false;
      if (!this.#closed && this.#pendingCount > 0) {
        this.#observeBackgroundDrain(this.#startDrain());
      }
    });
  }

  #observeBackgroundDrain(drain: Promise<FlushResult>): void {
    if (this.#backgroundPromise === drain) {
      return;
    }

    this.#backgroundPromise = drain;
    void drain.then(
      () => {
        if (this.#backgroundPromise === drain) {
          this.#backgroundPromise = undefined;
        }
      },
      (error: unknown) => {
        if (this.#backgroundPromise === drain) {
          this.#backgroundPromise = undefined;
        }
        if (this.#onError) {
          try {
            const handled = this.#onError(error);
            void Promise.resolve(handled).catch(() => undefined);
          } catch {
            // Background error handlers are advisory and must never destabilize
            // the process, whether they throw synchronously or reject.
          }
        }
      },
    );
  }

  #startDrain(): Promise<FlushResult> {
    if (this.#drainPromise) {
      return this.#drainPromise;
    }

    let drain!: Promise<FlushResult>;
    drain = (async () => {
      this.#debugLog("flush started", {
        pending: this.#pendingCount,
      });
      try {
        const result = await this.#drain();
        this.#debugLog("flush completed", {
          accepted: result.accepted,
          batches: result.batches.length,
          pending: this.#pendingCount,
        });
        return result;
      } catch (error) {
        this.#debugLog("flush failed", {
          errorMessage:
            error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : typeof error,
          pending: this.#pendingCount,
        });
        throw error;
      } finally {
        if (this.#drainPromise === drain) {
          this.#drainPromise = undefined;
        }
        if (this.#pendingCount === 0) {
          this.#clearTimer();
        } else if (!this.#closed) {
          this.#ensureTimer();
        }
      }
    })();
    this.#drainPromise = drain;
    return drain;
  }

  async #drain(): Promise<FlushResult> {
    const batches: IngestResult[] = [];
    let accepted = 0;

    while (this.#pendingCount > 0) {
      const batch =
        this.#preparedBatch ?? (await this.#prepareNextBatch());
      this.#preparedBatch = batch;

      const result = await this.#send(batch);
      for (const event of batch.events) {
        this.#pendingEventIds.delete(event.event_id as string);
      }
      this.#preparedBatch = undefined;
      this.#pendingCount -= batch.events.length;
      accepted += result.accepted;
      batches.push(result);
    }

    return { accepted, batches };
  }

  async #prepareNextBatch(): Promise<PreparedBatch> {
    let count = Math.min(this.#queue.length, TRAFFICWAR_MAX_BATCH_SIZE);
    if (count === 0) {
      throw new Error("TrafficWar queue state is inconsistent");
    }

    while (true) {
      const events = this.#queue.slice(0, count);
      const idempotencyKey = uuidv7();
      try {
        const prepared = await prepareRequest(
          events,
          idempotencyKey,
          this.compression,
          this.compressionThresholdBytes,
        );
        this.#queue.splice(0, count);
        const batch = { ...prepared, events, idempotencyKey };
        this.#debugLog("batch prepared", {
          bodyBytes: prepared.body.byteLength,
          contentEncoding: prepared.contentEncoding ?? "identity",
          events: events.length,
          idempotencyKey,
        });
        return batch;
      } catch (error) {
        if (!(error instanceof PreparedRequestTooLarge)) {
          throw error;
        }
        if (count > 1) {
          count = Math.max(1, Math.floor(count / 2));
          continue;
        }

        const message =
          error.limit === "decoded"
            ? `Decoded request body exceeds ${TRAFFICWAR_MAX_DECODED_BODY_BYTES} bytes`
            : `Request body exceeds the ${TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES}-byte wire limit`;
        throw new TrafficWarValidationError(message, {
          path: "body",
          idempotencyKey,
        });
      }
    }
  }

  async #send(
    batch: PreparedBatch,
    signal?: AbortSignal,
  ): Promise<IngestResult> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      "idempotency-key": batch.idempotencyKey,
      "user-agent": `@trafficwar/node/${SDK_VERSION}`,
      "x-trafficwar-sdk": `node/${SDK_VERSION}`,
    };
    if (batch.contentEncoding) {
      headers["content-encoding"] = batch.contentEncoding;
    }

    const url = `${this.baseUrl}/v1/server/batch`;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: batch.body,
      redirect: "error",
    };
    let sawTimeout = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) {
        throw new TrafficWarConnectionError(
          "TrafficWar request was aborted",
          {
            attempts: attempt,
            aborted: true,
            timedOut: sawTimeout,
            idempotencyKey: batch.idempotencyKey,
            cause: signal.reason,
          },
        );
      }

      this.#debugLog("request attempt", {
        attempt: attempt + 1,
        bodyBytes: batch.body.byteLength,
        events: batch.events.length,
        idempotencyKey: batch.idempotencyKey,
        maxAttempts: this.maxRetries + 1,
      });
      let result: AttemptResult;
      try {
        result = await executeAttempt(
          this.#fetch,
          url,
          init,
          signal,
          this.timeoutMs,
        );
      } catch (error) {
        const failure =
          error instanceof AttemptTransportFailure
            ? error
            : new AttemptTransportFailure(error, false);
        sawTimeout ||= failure.timedOut;

        if (signal?.aborted) {
          throw new TrafficWarConnectionError(
            "TrafficWar request was aborted",
            {
              attempts: attempt + 1,
              aborted: true,
              timedOut: sawTimeout,
              idempotencyKey: batch.idempotencyKey,
              cause: signal.reason ?? failure.cause,
            },
          );
        }

        if (attempt >= this.maxRetries) {
          throw new TrafficWarConnectionError(
            failure.timedOut
              ? `TrafficWar request timed out after ${this.timeoutMs} ms`
              : "Unable to reach TrafficWar",
            {
              attempts: attempt + 1,
              timedOut: sawTimeout,
              idempotencyKey: batch.idempotencyKey,
              cause: failure.cause,
            },
          );
        }

        const delayMs = retryDelayMs(attempt, undefined);
        this.#debugLog("request retry scheduled", {
          attempt: attempt + 1,
          delayMs,
          idempotencyKey: batch.idempotencyKey,
          reason: failure.timedOut ? "timeout" : "transport",
        });
        try {
          await sleep(delayMs, signal);
        } catch (cause) {
          throw new TrafficWarConnectionError(
            "TrafficWar request was aborted",
            {
              attempts: attempt + 1,
              aborted: true,
              timedOut: sawTimeout,
              idempotencyKey: batch.idempotencyKey,
              cause,
            },
          );
        }
        continue;
      }

      const parsed = parseBody(result.text);
      if (result.response.ok) {
        const ingest = parseSuccess(
          result.response,
          parsed,
          batch.events.length,
          batch.idempotencyKey,
        );
        this.#debugLog("request accepted", {
          accepted: ingest.accepted,
          attempt: attempt + 1,
          idempotencyKey: batch.idempotencyKey,
          ingestId: ingest.ingestId,
        });
        return ingest;
      }

      if (
        RETRYABLE_STATUSES.has(result.response.status) &&
        attempt < this.maxRetries
      ) {
        const retryAfter = retryAfterSeconds(result.response, parsed);
        if (
          retryAfter === undefined ||
          retryAfter <= MAX_RETRY_AFTER_SECONDS
        ) {
          const delayMs = retryDelayMs(attempt, retryAfter);
          this.#debugLog("request retry scheduled", {
            attempt: attempt + 1,
            delayMs,
            idempotencyKey: batch.idempotencyKey,
            reason: `http-${result.response.status}`,
          });
          try {
            await sleep(delayMs, signal);
          } catch (cause) {
            throw new TrafficWarConnectionError(
              "TrafficWar request was aborted",
              {
                attempts: attempt + 1,
                aborted: true,
                timedOut: sawTimeout,
                idempotencyKey: batch.idempotencyKey,
                cause,
              },
            );
          }
          continue;
        }
      }

      this.#debugLog("request rejected", {
        attempt: attempt + 1,
        idempotencyKey: batch.idempotencyKey,
        status: result.response.status,
      });
      throw buildApiError(
        result.response,
        parsed,
        batch.idempotencyKey,
      );
    }

    // The loop always returns or throws. Keep a defensive terminal for future
    // changes to retry bounds.
    throw new TrafficWarConnectionError("Unable to reach TrafficWar", {
      attempts: this.maxRetries + 1,
      timedOut: sawTimeout,
      idempotencyKey: batch.idempotencyKey,
    });
  }
}
