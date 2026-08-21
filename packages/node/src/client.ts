import { randomUUID } from "node:crypto";
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
  IngestResult,
  TrafficWarEvent,
  TrafficWarFetch,
  TrafficWarOptions,
  TrafficWarRequestOptions,
} from "./types";
import {
  assertUniqueEventIds,
  normalizeEvent,
  serializeJson,
  validateIdempotencyKey,
} from "./validation";
import packageMetadata from "../package.json" with { type: "json" };

export const TRAFFICWAR_DEFAULT_BASE_URL = "https://ingest.trafficwar.tech";
export const TRAFFICWAR_DEFAULT_TIMEOUT_MS = 30_000;
export const TRAFFICWAR_DEFAULT_MAX_RETRIES = 3;
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

interface ParsedBody {
  text: string;
  value: unknown;
  isJson: boolean;
}

interface RequestIdentity {
  idempotencyKey: string;
  signal: AbortSignal | undefined;
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

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function"
  );
}

function requestIdentity(
  options: TrafficWarRequestOptions | undefined,
): RequestIdentity {
  if (
    options !== undefined &&
    (options === null || typeof options !== "object" || Array.isArray(options))
  ) {
    throw new TrafficWarValidationError(
      "request options must be an object",
      { path: "options" },
    );
  }

  const idempotencyKey =
    options?.idempotencyKey === undefined
      ? randomUUID()
      : validateIdempotencyKey(options.idempotencyKey);
  const signal = options?.signal;
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TrafficWarValidationError(
      "signal must be an AbortSignal",
      { path: "options.signal", idempotencyKey },
    );
  }
  return { idempotencyKey, signal };
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
    throw new TrafficWarValidationError(
      `Decoded request body exceeds ${TRAFFICWAR_MAX_DECODED_BODY_BYTES} bytes`,
      { path: "body", idempotencyKey },
    );
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
    throw new TrafficWarValidationError(
      `Request body exceeds the ${TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES}-byte wire limit`,
      { path: "body", idempotencyKey },
    );
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
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly compression: CompressionMode;
  readonly compressionThresholdBytes: number;

  readonly #apiKey: string;
  readonly #fetch: TrafficWarFetch;

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
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw new TrafficWarValidationError(
        "fetch must be a function",
        { path: "options.fetch" },
      );
    }
    this.#fetch =
      options.fetch ??
      ((input, init) => {
        return globalThis.fetch(input, init);
      });
  }

  async capture(
    event: TrafficWarEvent,
    options?: TrafficWarRequestOptions,
  ): Promise<IngestResult> {
    const identity = requestIdentity(options);
    const normalized = normalizeEvent(
      event,
      "event",
      identity.idempotencyKey,
    );
    return this.#send(
      "/v1/server/capture",
      normalized,
      1,
      identity,
    );
  }

  async captureBatch(
    events: readonly TrafficWarEvent[],
    options?: TrafficWarRequestOptions,
  ): Promise<IngestResult> {
    const identity = requestIdentity(options);
    if (!Array.isArray(events) || events.length === 0) {
      throw new TrafficWarValidationError(
        "events must be a non-empty array",
        { path: "events", idempotencyKey: identity.idempotencyKey },
      );
    }
    if (events.length > TRAFFICWAR_MAX_BATCH_SIZE) {
      throw new TrafficWarValidationError(
        `events must contain at most ${TRAFFICWAR_MAX_BATCH_SIZE} events`,
        { path: "events", idempotencyKey: identity.idempotencyKey },
      );
    }

    const normalized = events.map((event, index) =>
      normalizeEvent(
        event,
        `events[${index}]`,
        identity.idempotencyKey,
      ),
    );
    assertUniqueEventIds(normalized, identity.idempotencyKey);
    return this.#send(
      "/v1/server/batch",
      normalized,
      normalized.length,
      identity,
    );
  }

  async #send(
    path: string,
    payload: unknown,
    expectedCount: number,
    identity: RequestIdentity,
  ): Promise<IngestResult> {
    const prepared = await prepareRequest(
      payload,
      identity.idempotencyKey,
      this.compression,
      this.compressionThresholdBytes,
    );
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      "idempotency-key": identity.idempotencyKey,
      "user-agent": `@trafficwar/node/${SDK_VERSION}`,
      "x-trafficwar-sdk": `node/${SDK_VERSION}`,
    };
    if (prepared.contentEncoding) {
      headers["content-encoding"] = prepared.contentEncoding;
    }

    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method: "POST",
      headers,
      body: prepared.body,
      redirect: "error",
    };
    let sawTimeout = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (identity.signal?.aborted) {
        throw new TrafficWarConnectionError(
          "TrafficWar request was aborted",
          {
            attempts: attempt,
            aborted: true,
            timedOut: sawTimeout,
            idempotencyKey: identity.idempotencyKey,
            cause: identity.signal.reason,
          },
        );
      }

      let result: AttemptResult;
      try {
        result = await executeAttempt(
          this.#fetch,
          url,
          init,
          identity.signal,
          this.timeoutMs,
        );
      } catch (error) {
        const failure =
          error instanceof AttemptTransportFailure
            ? error
            : new AttemptTransportFailure(error, false);
        sawTimeout ||= failure.timedOut;

        if (identity.signal?.aborted) {
          throw new TrafficWarConnectionError(
            "TrafficWar request was aborted",
            {
              attempts: attempt + 1,
              aborted: true,
              timedOut: sawTimeout,
              idempotencyKey: identity.idempotencyKey,
              cause: identity.signal.reason ?? failure.cause,
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
              idempotencyKey: identity.idempotencyKey,
              cause: failure.cause,
            },
          );
        }

        try {
          await sleep(retryDelayMs(attempt, undefined), identity.signal);
        } catch (cause) {
          throw new TrafficWarConnectionError(
            "TrafficWar request was aborted",
            {
              attempts: attempt + 1,
              aborted: true,
              timedOut: sawTimeout,
              idempotencyKey: identity.idempotencyKey,
              cause,
            },
          );
        }
        continue;
      }

      const parsed = parseBody(result.text);
      if (result.response.ok) {
        return parseSuccess(
          result.response,
          parsed,
          expectedCount,
          identity.idempotencyKey,
        );
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
          try {
            await sleep(retryDelayMs(attempt, retryAfter), identity.signal);
          } catch (cause) {
            throw new TrafficWarConnectionError(
              "TrafficWar request was aborted",
              {
                attempts: attempt + 1,
                aborted: true,
                timedOut: sawTimeout,
                idempotencyKey: identity.idempotencyKey,
                cause,
              },
            );
          }
          continue;
        }
      }

      throw buildApiError(
        result.response,
        parsed,
        identity.idempotencyKey,
      );
    }

    // The loop always returns or throws. Keep a defensive terminal for future
    // changes to retry bounds.
    throw new TrafficWarConnectionError("Unable to reach TrafficWar", {
      attempts: this.maxRetries + 1,
      timedOut: sawTimeout,
      idempotencyKey: identity.idempotencyKey,
    });
  }
}
