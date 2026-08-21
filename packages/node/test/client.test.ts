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
  TRAFFICWAR_DEFAULT_BASE_URL,
  TRAFFICWAR_DEFAULT_MAX_RETRIES,
  TRAFFICWAR_DEFAULT_TIMEOUT_MS,
} from "../src";
import type { TrafficWarFetch } from "../src";

interface ResponseOptions {
  status?: number;
  headers?: RequestInit["headers"];
  raw?: boolean;
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

afterEach(() => {
  vi.useRealTimers();
});

describe("TrafficWar request shape", () => {
  it("sends capture to the exact server route with auth and no Origin", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: TrafficWarFetch = async (url, init) => {
      calls.push({ url, init });
      return makeResponse({
        status: "ok",
        accepted: 1,
        ingest_id: "ing_01",
      });
    };
    const client = new TrafficWar({
      apiKey: "tw_test_key",
      compression: "none",
      fetch: fetcher,
    });

    const result = await client.capture(
      {
        event: "pageview",
        latency_ms: 12.5,
        properties: { path: "/pricing" },
      },
      { idempotencyKey: "capture-1" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://ingest.trafficwar.tech/v1/server/capture",
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.redirect).toBe("error");
    const headers = requestHeaders(calls[0]!.init);
    expect(headers.get("authorization")).toBe("Bearer tw_test_key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("capture-1");
    expect(headers.get("user-agent")).toBe(
      `@trafficwar/node/${packageMetadata.version}`,
    );
    expect(headers.get("x-trafficwar-sdk")).toBe(
      `node/${packageMetadata.version}`,
    );
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("content-encoding")).toBe(false);
    expect(bodyBuffer(calls[0]!.init).toString()).toBe(
      '{"event":"pageview","latency_ms":12.5,"properties":{"path":"/pricing"}}',
    );
    expect(result).toEqual({
      status: "ok",
      accepted: 1,
      ingestId: "ing_01",
      idempotencyKey: "capture-1",
    });
  });

  it("sends captureBatch as a bare array to the batch route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: TrafficWarFetch = async (url, init) => {
      calls.push({ url, init });
      return makeResponse({
        status: "ok",
        accepted: 2,
        ingest_id: "ing_batch",
      });
    };
    const client = new TrafficWar({
      apiKey: "tw_batch",
      baseUrl: "http://localhost:47317///",
      compression: "none",
      fetch: fetcher,
    });

    const result = await client.captureBatch(
      [{ event: "started" }, { event: "failed", status_code: 500 }],
      { idempotencyKey: "batch-1" },
    );

    expect(calls[0]?.url).toBe(
      "http://localhost:47317/v1/server/batch",
    );
    expect(bodyBuffer(calls[0]!.init).toString()).toBe(
      '[{"event":"started"},{"event":"failed","status_code":500}]',
    );
    expect(JSON.parse(bodyBuffer(calls[0]!.init).toString())).toEqual([
      { event: "started" },
      { event: "failed", status_code: 500 },
    ]);
    expect(result.accepted).toBe(2);
  });

  it("normalizes a Date without mutating the caller's event", async () => {
    let sent = "";
    const fetcher: TrafficWarFetch = async (_url, init) => {
      sent = bodyBuffer(init).toString();
      return makeResponse({
        status: "ok",
        accepted: 1,
        ingest_id: "ing_date",
      });
    };
    const date = new Date("2026-08-21T12:34:56.789Z");
    const event = Object.freeze({
      event: "clock",
      timestamp: date,
      properties: Object.freeze({ original: true }),
    });
    const client = new TrafficWar({
      apiKey: "tw_date",
      compression: "none",
      fetch: fetcher,
    });

    await client.capture(event, { idempotencyKey: "date-1" });

    expect(JSON.parse(sent)).toEqual({
      event: "clock",
      timestamp: "2026-08-21T12:34:56.789Z",
      properties: { original: true },
    });
    expect(event.timestamp).toBe(date);
    expect(date.toISOString()).toBe("2026-08-21T12:34:56.789Z");
  });

  it("gzip-compresses once in auto mode and sends decodable JSON", async () => {
    const calls: RequestInit[] = [];
    const fetcher: TrafficWarFetch = async (_url, init) => {
      calls.push(init);
      return makeResponse({
        status: "ok",
        accepted: 1,
        ingest_id: "ing_gzip",
      });
    };
    const client = new TrafficWar({
      apiKey: "tw_gzip",
      fetch: fetcher,
    });
    const event = {
      event: "large",
      properties: { payload: "compress-me-".repeat(200) },
    } as const;

    await client.capture(event, { idempotencyKey: "gzip-1" });

    expect(requestHeaders(calls[0]!).get("content-encoding")).toBe("gzip");
    expect(JSON.parse(gunzipSync(bodyBuffer(calls[0]!)).toString())).toEqual(
      event,
    );
  });

  it("uses identity below the automatic 1024-byte threshold", async () => {
    let seen: RequestInit | undefined;
    const client = new TrafficWar({
      apiKey: "tw_identity",
      fetch: async (_url, init) => {
        seen = init;
        return makeResponse({
          status: "ok",
          accepted: 1,
          ingest_id: "ing_identity",
        });
      },
    });

    await client.capture(
      { event: "small" },
      { idempotencyKey: "identity-1" },
    );

    expect(requestHeaders(seen!).has("content-encoding")).toBe(false);
    expect(bodyBuffer(seen!).toString()).toBe('{"event":"small"}');
  });

  it("exposes documented defaults", () => {
    const client = new TrafficWar({
      apiKey: "tw_defaults",
      fetch: async () =>
        makeResponse({ status: "ok", accepted: 1, ingest_id: "unused" }),
    });

    expect(client.baseUrl).toBe(TRAFFICWAR_DEFAULT_BASE_URL);
    expect(client.timeoutMs).toBe(TRAFFICWAR_DEFAULT_TIMEOUT_MS);
    expect(client.maxRetries).toBe(TRAFFICWAR_DEFAULT_MAX_RETRIES);
    expect(client.compression).toBe("auto");
    expect(client.compressionThresholdBytes).toBe(1024);
  });
});

describe("TrafficWar retries", () => {
  it("reuses the exact compressed bytes and automatic key across retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const calls: RequestInit[] = [];
    const responses = [
      makeResponse(
        {
          status: "pending",
          error: "durable insert is still pending",
          ingest_id: "ing_pending",
        },
        { status: 503, headers: { "retry-after": "0" } },
      ),
      makeResponse(
        { status: "error", error: "bad gateway" },
        { status: 502 },
      ),
      makeResponse({
        status: "ok",
        accepted: 1,
        ingest_id: "ing_done",
      }),
    ];
    const client = new TrafficWar({
      apiKey: "tw_retry",
      compression: "gzip",
      maxRetries: 2,
      fetch: async (_url, init) => {
        calls.push(init);
        return responses.shift()!;
      },
    });

    const result = await client.capture({
      event: "retry",
      properties: { payload: "same-body".repeat(200) },
    });

    expect(calls).toHaveLength(3);
    const keys = calls.map((call) =>
      requestHeaders(call).get("idempotency-key"),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[1]?.body).toBe(calls[2]?.body);
    expect(bodyBuffer(calls[0]!)).toEqual(bodyBuffer(calls[2]!));
    expect(result).toMatchObject({
      accepted: 1,
      ingestId: "ing_done",
      idempotencyKey: keys[0],
    });
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
        fetch: async () => {
          calls += 1;
          if (calls === 1) {
            return makeResponse(
              { status: "error", error: "retry" },
              { status },
            );
          }
          return makeResponse({
            status: "ok",
            accepted: 1,
            ingest_id: `ing_${status}`,
          });
        },
      });

      const result = await client.capture(
        { event: "retryable" },
        { idempotencyKey: `status-${status}` },
      );

      expect(calls).toBe(2);
      expect(result.ingestId).toBe(`ing_${status}`);
    },
  );

  it("retries transport failures", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const keys: Array<string | null> = [];
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_transport",
      compression: "none",
      maxRetries: 1,
      fetch: async (_url, init) => {
        calls += 1;
        keys.push(requestHeaders(init).get("idempotency-key"));
        if (calls === 1) {
          throw new TypeError("socket closed");
        }
        return makeResponse({
          status: "ok",
          accepted: 1,
          ingest_id: "ing_transport",
        });
      },
    });

    await expect(
      client.capture(
        { event: "transport" },
        { idempotencyKey: "transport-1" },
      ),
    ).resolves.toMatchObject({ ingestId: "ing_transport" });
    expect(calls).toBe(2);
    expect(keys).toEqual(["transport-1", "transport-1"]);
  });

  it("retries per-attempt timeouts and reports the final timeout", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_timeout",
      timeoutMs: 5,
      maxRetries: 1,
      compression: "none",
      fetch: async () => {
        calls += 1;
        return new Promise<Response>(() => {});
      },
    });

    await expect(
      client.capture(
        { event: "timeout" },
        { idempotencyKey: "timeout-1" },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarConnectionError",
      timedOut: true,
      aborted: false,
      attempts: 2,
      idempotencyKey: "timeout-1",
    });
    expect(calls).toBe(2);
  });

  it("honors Retry-After as a minimum retry delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_retry_after",
      compression: "none",
      maxRetries: 1,
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return makeResponse(
            { status: "pending", error: "pending", ingest_id: "ing_wait" },
            { status: 503, headers: { "retry-after": "1" } },
          );
        }
        return makeResponse({
          status: "ok",
          accepted: 1,
          ingest_id: "ing_after",
        });
      },
    });

    const pending = client.capture(
      { event: "wait" },
      { idempotencyKey: "wait-1" },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ ingestId: "ing_after" });
    expect(calls).toBe(2);
  });

  it("surfaces Retry-After values above the retry bound immediately", async () => {
    let calls = 0;
    const client = new TrafficWar({
      apiKey: "tw_retry_bound",
      maxRetries: 3,
      fetch: async () => {
        calls += 1;
        return makeResponse(
          { status: "pending", error: "try much later" },
          { status: 503, headers: { "retry-after": "61" } },
        );
      },
    });

    await expect(
      client.capture(
        { event: "bounded" },
        { idempotencyKey: "bounded-1" },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarApiError",
      status: 503,
      retryAfterSeconds: 61,
      idempotencyKey: "bounded-1",
    });
    expect(calls).toBe(1);
  });

  it("stops immediately when the caller's signal is already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    const client = new TrafficWar({
      apiKey: "tw_abort",
      fetch: async () => {
        calls += 1;
        return makeResponse({
          status: "ok",
          accepted: 1,
          ingest_id: "never",
        });
      },
    });

    await expect(
      client.capture(
        { event: "abort" },
        { idempotencyKey: "abort-1", signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarConnectionError",
      aborted: true,
      attempts: 0,
      idempotencyKey: "abort-1",
    });
    expect(calls).toBe(0);
  });
});

describe("TrafficWar responses and errors", () => {
  it("maps all 429 quota fields and never retries", async () => {
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
      fetch: async () => {
        calls += 1;
        return makeResponse(details, {
          status: 429,
          headers: { "retry-after": "3600" },
        });
      },
    });

    let thrown: unknown;
    try {
      await client.captureBatch(
        [{ event: "one" }, { event: "two" }],
        { idempotencyKey: "quota-1" },
      );
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
      idempotencyKey: "quota-1",
    });
    expect(calls).toBe(1);
  });

  it("never retries a 409 idempotency conflict", async () => {
    let calls = 0;
    const details = {
      status: "error",
      error: "Idempotency-Key was already used with a different request body",
    };
    const client = new TrafficWar({
      apiKey: "tw_conflict",
      maxRetries: 5,
      fetch: async () => {
        calls += 1;
        return makeResponse(details, { status: 409 });
      },
    });

    await expect(
      client.capture(
        { event: "conflict" },
        { idempotencyKey: "conflict-1" },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarApiError",
      status: 409,
      details,
      idempotencyKey: "conflict-1",
    });
    expect(calls).toBe(1);
  });

  it("retains pending ingest metadata after retries are exhausted", async () => {
    const details = {
      status: "pending",
      error: "durable insert is still pending",
      ingest_id: "0190-pending",
    };
    const client = new TrafficWar({
      apiKey: "tw_pending",
      maxRetries: 0,
      fetch: async () =>
        makeResponse(details, {
          status: 503,
          headers: { "retry-after": "1" },
        }),
    });

    await expect(
      client.capture(
        { event: "pending" },
        { idempotencyKey: "pending-1" },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarApiError",
      status: 503,
      details,
      retryAfterSeconds: 1,
      ingestId: "0190-pending",
      idempotencyKey: "pending-1",
    });
  });

  it("returns an API error with parsed details for non-retryable failures", async () => {
    const details = {
      status: "error",
      error: "invalid token",
      request_id: "req_1",
    };
    const client = new TrafficWar({
      apiKey: "tw_api_error",
      fetch: async () => makeResponse(details, { status: 403 }),
    });

    let thrown: unknown;
    try {
      await client.capture(
        { event: "forbidden" },
        { idempotencyKey: "forbidden-1" },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TrafficWarApiError);
    expect(thrown).toMatchObject({
      status: 403,
      message: "invalid token",
      details,
      idempotencyKey: "forbidden-1",
    });
  });

  it.each([
    { body: "<html>forbidden</html>", raw: true },
    { body: ["error", "forbidden"], raw: false },
    { body: { error: "forbidden" }, raw: false },
    { body: { status: "error" }, raw: false },
    { body: { status: "unknown", error: "forbidden" }, raw: false },
  ])("rejects malformed HTTP error envelopes as protocol errors", async ({
    body,
    raw,
  }) => {
    const client = new TrafficWar({
      apiKey: "tw_bad_error",
      maxRetries: 0,
      fetch: async () => makeResponse(body, { status: 403, raw }),
    });

    await expect(
      client.capture(
        { event: "bad-error" },
        { idempotencyKey: "bad-error-1" },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarProtocolError",
      status: 403,
      idempotencyKey: "bad-error-1",
    });
  });

  it("rejects malformed JSON success responses as protocol errors", async () => {
    const client = new TrafficWar({
      apiKey: "tw_protocol",
      fetch: async () => makeResponse("<html>oops</html>", { raw: true }),
    });

    let thrown: unknown;
    try {
      await client.capture(
        { event: "protocol" },
        { idempotencyKey: "protocol-1" },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TrafficWarProtocolError);
    expect(thrown).toMatchObject({
      status: 200,
      responseBody: "<html>oops</html>",
      idempotencyKey: "protocol-1",
    });
  });

  it("rejects malformed or partial success objects", async () => {
    const cases = [
      { status: "ok", accepted: "1", ingest_id: "ing_bad" },
      { status: "ok", accepted: 0, ingest_id: "ing_bad" },
      { status: "ok", accepted: 1, ingest_id: "" },
      { status: "pending", accepted: 1, ingest_id: "ing_bad" },
    ];

    for (const body of cases) {
      const client = new TrafficWar({
        apiKey: "tw_bad_success",
        fetch: async () => makeResponse(body),
      });
      await expect(
        client.capture(
          { event: "bad-success" },
          { idempotencyKey: `bad-${JSON.stringify(body)}`.slice(0, 200) },
        ),
      ).rejects.toBeInstanceOf(TrafficWarProtocolError);
    }
  });

  it("reports final transport failures as connection errors with the key", async () => {
    const failure = new TypeError("ECONNRESET");
    const client = new TrafficWar({
      apiKey: "tw_connection",
      maxRetries: 0,
      fetch: async () => {
        throw failure;
      },
    });

    let thrown: unknown;
    try {
      await client.capture(
        { event: "offline" },
        { idempotencyKey: "offline-1" },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TrafficWarConnectionError);
    expect(thrown).toMatchObject({
      attempts: 1,
      timedOut: false,
      aborted: false,
      idempotencyKey: "offline-1",
      cause: failure,
    });
  });
});
