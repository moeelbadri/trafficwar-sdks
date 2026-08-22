import { Buffer } from "node:buffer";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import packageMetadata from "../package.json" with { type: "json" };
import {
  TrafficWar,
  TrafficWarApiError,
  TrafficWarConnectionError,
  TrafficWarProtocolError,
  TrafficWarRateLimitError,
  TrafficWarValidationError,
  TRAFFICWAR_DEFAULT_BASE_URL,
  TRAFFICWAR_DEFAULT_FLUSH_INTERVAL_MS,
  TRAFFICWAR_DEFAULT_MAX_QUEUE_SIZE,
  TRAFFICWAR_DEFAULT_MAX_RETRIES,
  TRAFFICWAR_DEFAULT_TIMEOUT_MS,
  TRAFFICWAR_MAX_BATCH_SIZE,
  TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES,
  TRAFFICWAR_MAX_DECODED_BODY_BYTES,
} from "../src";
import type { TrafficWarFetch } from "../src";

interface ResponseOptions {
  status?: number;
  headers?: RequestInit["headers"];
  raw?: boolean;
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function makeResponse(
  body: unknown,
  options: ResponseOptions = {},
): Response {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const text = options.raw ? String(body) : JSON.stringify(body);
  return new Response(text, {
    status: options.status ?? 200,
    headers,
  });
}

function bodyBuffer(init: RequestInit): Buffer {
  const body = init.body;
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error(`Unexpected request body: ${String(body)}`);
}

function requestHeaders(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function decodedBody(init: RequestInit): Buffer {
  const body = bodyBuffer(init);
  return requestHeaders(init).get("content-encoding") === "gzip"
    ? gunzipSync(body)
    : body;
}

function decodedEvents(init: RequestInit): Array<Record<string, unknown>> {
  return JSON.parse(decodedBody(init).toString()) as Array<
    Record<string, unknown>
  >;
}

function successResponse(init: RequestInit, suffix = "ok"): Response {
  return makeResponse({
    status: "ok",
    accepted: decodedEvents(init).length,
    ingest_id: `ing_${suffix}`,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleBackground(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
  }
}

function expectUuidV7(value: unknown): asserts value is string {
  expect(value).toEqual(expect.any(String));
  expect(value).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TrafficWar queued capture", () => {
  it("queues one event without immediate transport and flushes a bare array", async () => {
    const calls: RecordedCall[] = [];
    const client = new TrafficWar({
      apiKey: "tw_test_key",
      compression: "none",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return successResponse(init, "one");
      },
    });

    const result = client.capture({
      event: "pageview",
      latency_ms: 12.5,
      properties: { path: "/pricing" },
    });

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);

    const flushed = await client.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://ingest.trafficwar.tech/v1/server/batch",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = requestHeaders(calls[0]!.init);
    expect(headers.get("authorization")).toBe("Bearer tw_test_key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("user-agent")).toBe(
      `@trafficwar/node/${packageMetadata.version}`,
    );
    expect(headers.get("x-trafficwar-sdk")).toBe(
      `node/${packageMetadata.version}`,
    );
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("content-encoding")).toBe(false);

    const events = decodedEvents(calls[0]!.init);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "pageview",
      latency_ms: 12.5,
      properties: { path: "/pricing" },
    });
    expectUuidV7(events[0]?.event_id);
    expect(flushed).toEqual({
      accepted: 1,
      batches: [
        {
          status: "ok",
          accepted: 1,
          ingestId: "ing_one",
          idempotencyKey: headers.get("idempotency-key"),
        },
      ],
    });
  });

  it("accepts a readonly array and keeps captureBatch as a queued alias", async () => {
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_batch",
      baseUrl: "http://localhost:47317///",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return successResponse(init, String(calls.length));
      },
    });
    const events = Object.freeze([
      Object.freeze({ event: "started" }),
      Object.freeze({ event: "failed", status_code: 500 }),
    ]);

    expect(client.capture(events)).toBeUndefined();
    expect(
      client.captureBatch(Object.freeze([{ event: "legacy" }])),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);

    const result = await client.flush();
    expect(calls).toHaveLength(1);
    expect(decodedEvents(calls[0]!)).toMatchObject([
      { event: "started" },
      { event: "failed", status_code: 500 },
      { event: "legacy" },
    ]);
    expect(result.accepted).toBe(3);
  });

  it("deeply snapshots input and normalizes Date without caller mutation", async () => {
    let sent: Array<Record<string, unknown>> = [];
    const client = new TrafficWar({
      apiKey: "tw_snapshot",
      compression: "none",
      fetch: async (_url, init) => {
        sent = decodedEvents(init);
        return successResponse(init, "snapshot");
      },
    });
    const date = new Date("2026-08-21T12:34:56.789Z");
    const nested = { original: true, values: [1, 2] };
    const event = {
      event: "clock",
      timestamp: date,
      properties: nested,
    };

    client.capture(event);
    event.event = "mutated";
    date.setUTCFullYear(2030);
    nested.original = false;
    nested.values.push(3);
    await client.flush();

    expect(sent[0]).toMatchObject({
      event: "clock",
      timestamp: "2026-08-21T12:34:56.789Z",
      properties: { original: true, values: [1, 2] },
    });
    expect(event).not.toHaveProperty("event_id");
  });

  it("generates unique, ordered UUIDv7 event IDs and preserves overrides", async () => {
    const override = "550e8400-e29b-41d4-a716-446655440000";
    let sent: Array<Record<string, unknown>> = [];
    const client = new TrafficWar({
      apiKey: "tw_ids",
      compression: "none",
      fetch: async (_url, init) => {
        sent = decodedEvents(init);
        return successResponse(init, "ids");
      },
    });

    client.capture([
      ...Array.from({ length: 128 }, (_, index) => ({
        event: `generated-${index}`,
      })),
      { event: "override", event_id: override },
    ]);
    await client.flush();

    const generated = sent
      .slice(0, 128)
      .map((event) => event.event_id as string);
    for (const eventId of generated) {
      expectUuidV7(eventId);
    }
    expect(new Set(generated)).toHaveLength(128);
    expect(generated).toEqual([...generated].sort());
    expect(sent[128]?.event_id).toBe(override);
  });

  it("gzip-compresses a queued batch once and sends decodable JSON", async () => {
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_gzip",
      compression: "gzip",
      fetch: async (_url, init) => {
        calls.push(init);
        return successResponse(init, "gzip");
      },
    });
    client.capture({
      event: "large",
      properties: { payload: "compress-me-".repeat(200) },
    });

    await client.flush();

    expect(requestHeaders(calls[0]!).get("content-encoding")).toBe("gzip");
    expect(decodedEvents(calls[0]!)[0]).toMatchObject({ event: "large" });
  });

  it("exposes queue and transport defaults", () => {
    const client = new TrafficWar({
      apiKey: "tw_defaults",
      fetch: async (_url, init) => successResponse(init, "unused"),
    });

    expect(client.baseUrl).toBe(TRAFFICWAR_DEFAULT_BASE_URL);
    expect(client.timeoutMs).toBe(TRAFFICWAR_DEFAULT_TIMEOUT_MS);
    expect(client.maxRetries).toBe(TRAFFICWAR_DEFAULT_MAX_RETRIES);
    expect(client.flushIntervalMs).toBe(
      TRAFFICWAR_DEFAULT_FLUSH_INTERVAL_MS,
    );
    expect(client.maxQueueSize).toBe(
      TRAFFICWAR_DEFAULT_MAX_QUEUE_SIZE,
    );
    expect(client.debug).toBe(false);
    expect(client.compression).toBe("auto");
    expect(client.compressionThresholdBytes).toBe(1024);
  });

  it("prints safe batch lifecycle diagnostics when debug is enabled", async () => {
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    try {
      const client = new TrafficWar({
        apiKey: "tw_debug_secret",
        compression: "none",
        debug: true,
        fetch: async (_url, init) => successResponse(init, "debug"),
      });

      client.capture({
        event: "private.event",
        properties: { token: "private-property" },
      });
      await client.flush();
      await client.close();

      const messages = debug.mock.calls.map(([message]) => message);
      expect(messages).toEqual(
        expect.arrayContaining([
          "[TrafficWar] client initialized",
          "[TrafficWar] events queued",
          "[TrafficWar] flush timer scheduled",
          "[TrafficWar] manual flush requested",
          "[TrafficWar] flush started",
          "[TrafficWar] batch prepared",
          "[TrafficWar] request attempt",
          "[TrafficWar] request accepted",
          "[TrafficWar] flush completed",
          "[TrafficWar] client closed",
        ]),
      );

      const output = JSON.stringify(debug.mock.calls);
      expect(output).not.toContain("tw_debug_secret");
      expect(output).not.toContain("private.event");
      expect(output).not.toContain("private-property");
    } finally {
      debug.mockRestore();
    }
  });

  it("does not print diagnostics when debug is disabled", async () => {
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    try {
      const client = new TrafficWar({
        apiKey: "tw_quiet",
        compression: "none",
        fetch: async (_url, init) => successResponse(init, "quiet"),
      });

      client.capture({ event: "quiet" });
      await client.close();

      expect(debug).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });

  it("unrefs the one-shot queue timer", async () => {
    const sample = setTimeout(() => undefined, 10_000);
    const prototype = Object.getPrototypeOf(sample) as {
      unref: () => NodeJS.Timeout;
    };
    clearTimeout(sample);
    const unref = vi.spyOn(prototype, "unref");
    const client = new TrafficWar({
      apiKey: "tw_unref",
      compression: "none",
      fetch: async (_url, init) => successResponse(init, "unref"),
    });

    client.capture({ event: "unref" });
    expect(unref).toHaveBeenCalledTimes(1);
    await client.flush();
  });
});

describe("TrafficWar automatic batching", () => {
  it("uses one 1000 ms timer from the first pending event", async () => {
    vi.useFakeTimers();
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_timer",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return successResponse(init, "timer");
      },
    });

    client.capture({ event: "first" });
    await vi.advanceTimersByTimeAsync(500);
    client.capture({ event: "second" });
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    expect(decodedEvents(calls[0]!)).toHaveLength(2);
    await client.flush();
  });

  it("starts a background flush when 10,000 events are pending", async () => {
    const calls: RequestInit[] = [];
    const gate = deferred<Response>();
    const client = new TrafficWar({
      apiKey: "tw_threshold",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return gate.promise;
      },
    });

    client.capture(
      Array.from({ length: TRAFFICWAR_MAX_BATCH_SIZE }, (_, index) => ({
        event: `threshold-${index}`,
      })),
    );
    expect(calls).toHaveLength(0);
    await settleBackground();
    expect(calls).toHaveLength(1);
    expect(decodedEvents(calls[0]!)).toHaveLength(
      TRAFFICWAR_MAX_BATCH_SIZE,
    );

    gate.resolve(successResponse(calls[0]!, "threshold"));
    await client.flush();
  });

  it("splits inputs larger than 10,000 into fixed-ceiling batches", async () => {
    const sizes: number[] = [];
    const keys: string[] = [];
    const client = new TrafficWar({
      apiKey: "tw_chunks",
      compression: "none",
      fetch: async (_url, init) => {
        sizes.push(decodedEvents(init).length);
        keys.push(requestHeaders(init).get("idempotency-key")!);
        return successResponse(init, String(sizes.length));
      },
    });

    client.capture(
      Array.from({ length: 25_001 }, (_, index) => ({
        event: `chunk-${index}`,
      })),
    );
    const result = await client.flush();

    expect(sizes).toEqual([10_000, 10_000, 5_001]);
    expect(result.accepted).toBe(25_001);
    expect(result.batches.map((batch) => batch.accepted)).toEqual(sizes);
    for (const key of keys) {
      expectUuidV7(key);
    }
    expect(new Set(keys)).toHaveLength(3);
    expect(keys).toEqual([...keys].sort());
  });

  it("enqueues more than 130,000 events without argument-limit spreads", async () => {
    const eventCount = 130_001;
    let accepted = 0;
    const client = new TrafficWar({
      apiKey: "tw_large_queue",
      compression: "none",
      maxQueueSize: eventCount,
      fetch: async (_url, init) => {
        const count = decodedEvents(init).length;
        accepted += count;
        return successResponse(init, String(accepted));
      },
    });
    const event = Object.freeze({ event: "large-queue" });
    const events = Array.from({ length: eventCount }, () => event);

    expect(() => client.capture(events)).not.toThrow();
    const result = await client.flush();

    expect(result.accepted).toBe(eventCount);
    expect(accepted).toBe(eventCount);
    expect(result.batches).toHaveLength(
      Math.ceil(eventCount / TRAFFICWAR_MAX_BATCH_SIZE),
    );
  });

  it("splits batches to remain below the 2 MiB identity wire limit", async () => {
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_wire_split",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return successResponse(init, String(calls.length));
      },
    });

    client.capture(
      Array.from({ length: 10 }, (_, index) => ({
        event: `wire-${index}`,
        properties: { payload: "x".repeat(300_000) },
      })),
    );
    const result = await client.flush();

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => bodyBuffer(call).byteLength <=
      TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES)).toBe(true);
    expect(
      calls.reduce((sum, call) => sum + decodedEvents(call).length, 0),
    ).toBe(10);
    expect(result.accepted).toBe(10);
  });

  it("splits before gzip to remain below the 8 MiB decoded limit", async () => {
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_decoded_split",
      compression: "gzip",
      fetch: async (_url, init) => {
        calls.push(init);
        return successResponse(init, String(calls.length));
      },
    });

    client.capture(
      Array.from({ length: 20 }, (_, index) => ({
        event: `decoded-${index}`,
        properties: { payload: "compressible".repeat(40_000) },
      })),
    );
    const result = await client.flush();

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => decodedBody(call).byteLength <=
      TRAFFICWAR_MAX_DECODED_BODY_BYTES)).toBe(true);
    expect(
      calls.reduce((sum, call) => sum + decodedEvents(call).length, 0),
    ).toBe(20);
    expect(result.accepted).toBe(20);
  });

  it("serializes concurrent flushes and accepts captures during flight", async () => {
    const calls: RequestInit[] = [];
    const first = deferred<Response>();
    const client = new TrafficWar({
      apiKey: "tw_singleflight",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return calls.length === 1
          ? first.promise
          : successResponse(init, "second");
      },
    });
    client.capture({ event: "first" });

    const flushA = client.flush();
    const flushB = client.flush();
    expect(flushA).toBe(flushB);
    await settleBackground();
    expect(calls).toHaveLength(1);

    client.capture({ event: "during-flight" });
    first.resolve(successResponse(calls[0]!, "first"));

    const [resultA, resultB] = await Promise.all([flushA, flushB]);
    expect(calls).toHaveLength(2);
    expect(resultA).toBe(resultB);
    expect(resultA.accepted).toBe(2);
    expect(resultA.batches).toHaveLength(2);
    expect(decodedEvents(calls[1]!)[0]?.event).toBe("during-flight");
  });

  it("enforces the configurable cap across queued and in-flight events", async () => {
    const gate = deferred<Response>();
    let call: RequestInit | undefined;
    const client = new TrafficWar({
      apiKey: "tw_cap",
      compression: "none",
      maxQueueSize: 2,
      fetch: async (_url, init) => {
        call = init;
        return gate.promise;
      },
    });
    client.capture([{ event: "one" }, { event: "two" }]);
    const flushing = client.flush();
    await settleBackground();

    expect(() => client.capture({ event: "overflow" })).toThrow(
      TrafficWarValidationError,
    );
    expect(() => client.capture({ event: "overflow" })).toThrow(
      /queue cannot exceed 2 events/,
    );

    gate.resolve(successResponse(call!, "cap"));
    await flushing;
  });

  it("protects an event ID while its batch is in flight", async () => {
    const eventId = "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb";
    const gate = deferred<Response>();
    let call: RequestInit | undefined;
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_inflight_id",
      compression: "none",
      fetch: async (_url, init) => {
        calls += 1;
        call = init;
        return calls === 1
          ? gate.promise
          : successResponse(init, "reuse-id");
      },
    });
    client.capture({ event: "in-flight", event_id: eventId });
    const flushing = client.flush();
    await settleBackground();

    expect(() =>
      client.capture({ event: "duplicate", event_id: eventId }),
    ).toThrow(
      expect.objectContaining({ path: "event.event_id" }),
    );

    gate.resolve(successResponse(call!, "inflight-id"));
    await flushing;
    expect(() =>
      client.capture({ event: "reuse", event_id: eventId }),
    ).not.toThrow();
    await client.flush();
  });
});

describe("TrafficWar failures and idempotency", () => {
  it("reuses exact bytes and one UUIDv7 key across HTTP retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_retry",
      compression: "gzip",
      maxRetries: 2,
      fetch: async (_url, init) => {
        calls.push(init);
        if (calls.length < 3) {
          return makeResponse(
            { status: "error", error: "retry" },
            { status: calls.length === 1 ? 503 : 502 },
          );
        }
        return successResponse(init, "retry");
      },
    });
    client.capture({
      event: "retry",
      properties: { payload: "same-body".repeat(200) },
    });

    const result = await client.flush();

    expect(calls).toHaveLength(3);
    const keys = calls.map((call) =>
      requestHeaders(call).get("idempotency-key"),
    );
    expect(new Set(keys)).toHaveLength(1);
    expectUuidV7(keys[0]);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[1]?.body).toBe(calls[2]?.body);
    expect(result.batches[0]?.idempotencyKey).toBe(keys[0]);
  });

  it("retains a failed background batch and reports it through onError", async () => {
    vi.useFakeTimers();
    const calls: RequestInit[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const client = new TrafficWar({
      apiKey: "tw_background_failure",
      compression: "none",
      maxRetries: 0,
      onError: (error) => {
        errors.push(error);
      },
      fetch: async (_url, init) => {
        calls.push(init);
        if (fail) {
          return makeResponse(
            { status: "error", error: "temporarily unavailable" },
            { status: 503 },
          );
        }
        return successResponse(init, "recovered");
      },
    });
    client.capture({ event: "retained", properties: { n: 1 } });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TrafficWarApiError);

    fail = false;
    const result = await client.flush();
    expect(result.accepted).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(requestHeaders(calls[0]!).get("idempotency-key")).toBe(
      requestHeaders(calls[1]!).get("idempotency-key"),
    );
  });

  it("consumes a rejected Promise returned by onError", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let fail = true;
    const handlerFailure = new Error("onError rejected");
    const onError = vi.fn(async () => {
      throw handlerFailure;
    });
    const client = new TrafficWar({
      apiKey: "tw_async_on_error",
      compression: "none",
      maxRetries: 0,
      onError,
      fetch: async (_url, init) =>
        fail
          ? makeResponse(
              { status: "error", error: "background failed" },
              { status: 503 },
            )
          : successResponse(init, "async-on-error-retry"),
    });

    try {
      client.capture({ event: "async-on-error" });
      await vi.advanceTimersByTimeAsync(1_000);
      await settleBackground();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);

      fail = false;
      await client.flush();
      await settleBackground();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("continues swallowing synchronous onError throws", async () => {
    vi.useFakeTimers();
    let fail = true;
    const onError = vi.fn(() => {
      throw new Error("onError threw");
    });
    const client = new TrafficWar({
      apiKey: "tw_sync_on_error",
      compression: "none",
      maxRetries: 0,
      onError,
      fetch: async (_url, init) =>
        fail
          ? makeResponse(
              { status: "error", error: "background failed" },
              { status: 503 },
            )
          : successResponse(init, "sync-on-error-retry"),
    });
    client.capture({ event: "sync-on-error" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledTimes(1);

    fail = false;
    await expect(client.flush()).resolves.toMatchObject({ accepted: 1 });
  });

  it("automatically retries a retained background batch on a new one-shot timer", async () => {
    vi.useFakeTimers();
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_background_retry",
      compression: "none",
      maxRetries: 0,
      fetch: async (_url, init) => {
        calls.push(init);
        return calls.length === 1
          ? makeResponse(
              { status: "error", error: "temporarily unavailable" },
              { status: 503 },
            )
          : successResponse(init, "background-retry");
      },
    });
    client.capture({ event: "automatic-retry" });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(requestHeaders(calls[0]!).get("idempotency-key")).toBe(
      requestHeaders(calls[1]!).get("idempotency-key"),
    );
    await expect(client.flush()).resolves.toEqual({
      accepted: 0,
      batches: [],
    });
  });

  it("re-surfaces retained failures from every manual flush", async () => {
    const failure = new TypeError("ECONNRESET");
    let fail = true;
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_manual_failure",
      compression: "none",
      maxRetries: 0,
      fetch: async (_url, init) => {
        calls += 1;
        if (fail) {
          throw failure;
        }
        return successResponse(init, "recovered");
      },
    });
    client.capture({ event: "offline" });

    await expect(client.flush()).rejects.toMatchObject({
      name: "TrafficWarConnectionError",
      attempts: 1,
      cause: failure,
    });
    await expect(client.flush()).rejects.toBeInstanceOf(
      TrafficWarConnectionError,
    );
    expect(calls).toBe(2);

    fail = false;
    await expect(client.flush()).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toBe(3);
  });

  it("keeps failed batch event IDs reserved until acknowledgement", async () => {
    const eventId = "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb";
    let fail = true;
    const client = new TrafficWar({
      apiKey: "tw_failed_id",
      compression: "none",
      maxRetries: 0,
      fetch: async (_url, init) =>
        fail
          ? makeResponse(
              { status: "error", error: "temporarily unavailable" },
              { status: 503 },
            )
          : successResponse(init, "failed-id-retry"),
    });
    client.capture({ event: "retained-id", event_id: eventId });

    await expect(client.flush()).rejects.toBeInstanceOf(
      TrafficWarApiError,
    );
    expect(() =>
      client.capture({ event: "duplicate", event_id: eventId }),
    ).toThrow(
      expect.objectContaining({ path: "event.event_id" }),
    );

    fail = false;
    await client.flush();
    expect(() =>
      client.capture({ event: "reuse", event_id: eventId }),
    ).not.toThrow();
    await client.flush();
  });

  it.each([408, 425, 500, 502, 503, 504])(
    "retries HTTP %i",
    async (status) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      let calls = 0;
      const client = new TrafficWar({
        apiKey: "tw_status",
        compression: "none",
        maxRetries: 1,
        fetch: async (_url, init) => {
          calls += 1;
          return calls === 1
            ? makeResponse(
                { status: "error", error: "retry" },
                { status },
              )
            : successResponse(init, String(status));
        },
      });
      client.capture({ event: "retryable" });

      const result = await client.flush();
      expect(calls).toBe(2);
      expect(result.batches[0]?.ingestId).toBe(`ing_${status}`);
    },
  );

  it("honors Retry-After as a minimum retry delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_retry_after",
      compression: "none",
      maxRetries: 1,
      fetch: async (_url, init) => {
        calls += 1;
        return calls === 1
          ? makeResponse(
              { status: "pending", error: "pending", ingest_id: "ing_wait" },
              { status: 503, headers: { "retry-after": "1" } },
            )
          : successResponse(init, "after");
      },
    });
    client.capture({ event: "wait" });
    const pending = client.flush();

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toBe(2);
  });

  it("maps quota errors and never retries 429", async () => {
    let fail = true;
    let calls = 0;
    const details = {
      status: "error",
      error: "batch exceeds remaining quota",
      period: "monthly",
      used: 900,
      limit: 1000,
      remaining_events: 100,
      batch_events: 200,
      retry_after_secs: 3600,
    };
    const client = new TrafficWar({
      apiKey: "tw_quota",
      maxRetries: 10,
      fetch: async (_url, init) => {
        calls += 1;
        return fail
          ? makeResponse(details, {
              status: 429,
              headers: { "retry-after": "3600" },
            })
          : successResponse(init, "quota-retry");
      },
    });
    client.capture([{ event: "one" }, { event: "two" }]);

    let thrown: unknown;
    try {
      await client.flush();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TrafficWarRateLimitError);
    expect(thrown).toMatchObject({
      status: 429,
      message: "batch exceeds remaining quota",
      details,
      period: "monthly",
      used: 900,
      limit: 1000,
      remainingEvents: 100,
      batchEvents: 200,
      retryAfterSecs: 3600,
      retryAfterSeconds: 3600,
    });
    expect(calls).toBe(1);

    fail = false;
    await client.flush();
  });

  it("retains protocol parsing behavior", async () => {
    let malformed = true;
    const client = new TrafficWar({
      apiKey: "tw_protocol",
      maxRetries: 0,
      fetch: async (_url, init) =>
        malformed
          ? makeResponse("<html>oops</html>", { raw: true })
          : successResponse(init, "protocol-retry"),
    });
    client.capture({ event: "protocol" });

    await expect(client.flush()).rejects.toMatchObject({
      name: "TrafficWarProtocolError",
      status: 200,
      responseBody: "<html>oops</html>",
    });
    malformed = false;
    await expect(client.flush()).resolves.toMatchObject({ accepted: 1 });
  });

  it("surfaces Retry-After above the retry bound without retrying", async () => {
    let fail = true;
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_bound",
      maxRetries: 3,
      fetch: async (_url, init) => {
        calls += 1;
        return fail
          ? makeResponse(
              { status: "pending", error: "try much later" },
              { status: 503, headers: { "retry-after": "61" } },
            )
          : successResponse(init, "bound-retry");
      },
    });
    client.capture({ event: "bounded" });

    await expect(client.flush()).rejects.toMatchObject({
      name: "TrafficWarApiError",
      status: 503,
      retryAfterSeconds: 61,
    });
    expect(calls).toBe(1);
    fail = false;
    await client.flush();
  });
});

describe("TrafficWar lifecycle", () => {
  it("manual flush returns an empty compact result when there is no work", async () => {
    const client = new TrafficWar({
      apiKey: "tw_empty",
      fetch: async (_url, init) => successResponse(init, "unused"),
    });

    await expect(client.flush()).resolves.toEqual({
      accepted: 0,
      batches: [],
    });
  });

  it("close drains, seals only after success, and is idempotent", async () => {
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_close",
      compression: "none",
      fetch: async (_url, init) => {
        calls += 1;
        return successResponse(init, "close");
      },
    });
    client.capture({ event: "close" });

    await expect(client.close()).resolves.toMatchObject({
      accepted: 1,
    });
    expect(calls).toBe(1);
    expect(() => client.capture({ event: "late" })).toThrow(/closed/);
    await expect(client.close()).resolves.toEqual({
      accepted: 0,
      batches: [],
    });
  });

  it("rejects capture during close and makes flush join the close aggregate", async () => {
    const gate = deferred<Response>();
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_closing",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return gate.promise;
      },
    });
    client.capture([{ event: "one" }, { event: "two" }]);

    const closing = client.close();
    expect(() => client.capture({ event: "too-late" })).toThrow(
      expect.objectContaining({
        name: "TrafficWarValidationError",
        path: "client",
      }),
    );
    const flushing = client.flush();
    expect(flushing).toBe(closing);
    await settleBackground();
    expect(calls).toHaveLength(1);

    gate.resolve(successResponse(calls[0]!, "closing"));
    const [closeResult, flushResult] = await Promise.all([
      closing,
      flushing,
    ]);
    expect(closeResult).toBe(flushResult);
    expect(closeResult.accepted).toBe(2);
  });

  it("close joins an in-flight manual drain without double-sending", async () => {
    const gate = deferred<Response>();
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_close_singleflight",
      compression: "none",
      fetch: async (_url, init) => {
        calls.push(init);
        return gate.promise;
      },
    });
    client.capture({ event: "singleflight-close" });

    const flushing = client.flush();
    const closing = client.close();
    await settleBackground();
    expect(calls).toHaveLength(1);

    gate.resolve(successResponse(calls[0]!, "close-singleflight"));
    await expect(flushing).resolves.toMatchObject({ accepted: 1 });
    await expect(closing).resolves.toMatchObject({ accepted: 1 });
    expect(calls).toHaveLength(1);
    expect(() => client.capture({ event: "late" })).toThrow(/closed/);
  });

  it("a failed close retains work and leaves the client retryable", async () => {
    let fail = true;
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_close_retry",
      compression: "none",
      maxRetries: 0,
      fetch: async (_url, init) => {
        calls.push(init);
        return fail
          ? makeResponse(
              { status: "error", error: "maintenance" },
              { status: 503 },
            )
          : successResponse(init, String(calls.length));
      },
    });
    client.capture({ event: "before-failed-close" });

    const failedClose = client.close();
    expect(() =>
      client.capture({ event: "during-failed-close" }),
    ).toThrow(/closing/);
    expect(client.flush()).toBe(failedClose);
    await expect(failedClose).rejects.toBeInstanceOf(TrafficWarApiError);
    expect(() => client.capture({ event: "after-failed-close" })).not.toThrow();

    fail = false;
    const result = await client.close();
    expect(result.accepted).toBe(2);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(requestHeaders(calls[0]!).get("idempotency-key")).toBe(
      requestHeaders(calls[1]!).get("idempotency-key"),
    );
    expect(decodedEvents(calls[2]!)[0]?.event).toBe("after-failed-close");
  });
});
