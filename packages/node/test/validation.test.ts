import { describe, expect, it, vi } from "vitest";

import {
  TrafficWar,
  TrafficWarValidationError,
  TRAFFICWAR_MAX_BATCH_SIZE,
  TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES,
  TRAFFICWAR_MAX_DECODED_BODY_BYTES,
} from "../src";
import type {
  TrafficWarEvent,
  TrafficWarFetch,
  TrafficWarOptions,
} from "../src";

function success(accepted = 1): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      accepted,
      ingest_id: "ing_valid",
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function clientWith(fetch: TrafficWarFetch): TrafficWar {
  return new TrafficWar({
    apiKey: "tw_validation",
    compression: "none",
    fetch,
  });
}

describe("TrafficWar constructor validation", () => {
  it.each([
    undefined,
    null,
    "key",
    [],
  ])("rejects non-object options: %j", (options) => {
    expect(
      () => new TrafficWar(options as unknown as TrafficWarOptions),
    ).toThrow(TrafficWarValidationError);
  });

  it.each(["", " ", "key with spaces", "\u0000key", "é"])(
    "rejects an invalid API key",
    (apiKey) => {
      expect(
        () =>
          new TrafficWar({
            apiKey,
            fetch: async () => success(),
          }),
      ).toThrow(/apiKey/);
    },
  );

  it.each([
    "not a url",
    "ftp://example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?query=1",
    "https://example.com#fragment",
  ])("rejects invalid base URL %s", (baseUrl) => {
    expect(
      () =>
        new TrafficWar({
          apiKey: "tw_key",
          baseUrl,
          fetch: async () => success(),
        }),
    ).toThrow(/baseUrl/);
  });

  it("accepts URL objects and canonicalizes trailing slashes", () => {
    const client = new TrafficWar({
      apiKey: "tw_key",
      baseUrl: new URL("https://example.com///"),
      fetch: async () => success(),
    });

    expect(client.baseUrl).toBe("https://example.com");
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { maxRetries: -1 },
    { maxRetries: 101 },
    { compressionThresholdBytes: -1 },
    { compressionThresholdBytes: TRAFFICWAR_MAX_DECODED_BODY_BYTES + 1 },
    { compression: "brotli" },
    { fetch: "not-fetch" },
  ])("rejects invalid client options: %j", (invalid) => {
    expect(
      () =>
        new TrafficWar({
          apiKey: "tw_key",
          ...invalid,
        } as unknown as TrafficWarOptions),
    ).toThrow(TrafficWarValidationError);
  });
});

describe("TrafficWar event validation", () => {
  it.each([
    null,
    undefined,
    "event",
    1,
    [],
    {},
    { event: "" },
    { event: "   " },
    { event: 42 },
  ])("rejects invalid capture input: %j", async (event) => {
    const fetch = vi.fn(async () => success());
    const client = clientWith(fetch);

    await expect(
      client.capture(event as unknown as TrafficWarEvent, {
        idempotencyKey: "bad-event",
      }),
    ).rejects.toBeInstanceOf(TrafficWarValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite latency %s",
    async (latency_ms) => {
      const client = clientWith(async () => success());
      await expect(
        client.capture(
          { event: "latency", latency_ms },
          { idempotencyKey: "bad-latency" },
        ),
      ).rejects.toMatchObject({
        name: "TrafficWarValidationError",
        path: "event.latency_ms",
        idempotencyKey: "bad-latency",
      });
    },
  );

  it.each([-1, 65_536, 1.5, Number.NaN, "500"])(
    "rejects invalid status_code %s",
    async (status_code) => {
      const client = clientWith(async () => success());
      await expect(
        client.capture(
          {
            event: "status",
            status_code,
          } as unknown as TrafficWarEvent,
          { idempotencyKey: "bad-status" },
        ),
      ).rejects.toMatchObject({ path: "event.status_code" });
    },
  );

  it.each([
    "today",
    "2026-08-21",
    "2026-02-29T12:00:00Z",
    "2026-02-30T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-08-21T24:00:00Z",
    "2026-08-21T12:60:00Z",
    "2026-08-21T12:00:60Z",
    "2026-08-21T12:00:00+24:00",
    "2026-08-21T12:00:00+01:60",
    Number.NaN,
    1.5,
    Number.MAX_VALUE,
    new Date("invalid"),
    null,
  ])("rejects invalid timestamps", async (timestamp) => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        { event: "timestamp", timestamp } as unknown as TrafficWarEvent,
        { idempotencyKey: "bad-time" },
      ),
    ).rejects.toMatchObject({ path: "event.timestamp" });
  });

  it.each([
    "2026-08-21T12:30:00Z",
    "2026-08-21T12:30:00.123456+02:00",
    "2024-02-29T23:59:59.123456789-05:30",
    1_776_771_000_000,
  ])("accepts timestamp value %s", async (timestamp) => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        { event: "timestamp", timestamp },
        { idempotencyKey: `time-${String(timestamp)}` },
      ),
    ).resolves.toMatchObject({ accepted: 1 });
  });

  it.each([
    "",
    "not-a-uuid",
    "0190b0d0-acbd-7a2d-9bc",
    "0190b0d0acbd7a2d9bc09a36b7e269fb",
  ])("rejects invalid event_id %s", async (event_id) => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        { event: "id", event_id },
        { idempotencyKey: "bad-id" },
      ),
    ).rejects.toMatchObject({ path: "event.event_id" });
  });

  it("accepts a UUID event_id and does not synthesize one when omitted", async () => {
    const bodies: string[] = [];
    const client = clientWith(async (_url, init) => {
      const body = init.body;
      if (!(body instanceof Uint8Array)) {
        throw new Error("unexpected body");
      }
      bodies.push(Buffer.from(body).toString());
      return success();
    });

    await client.capture(
      {
        event: "with-id",
        event_id: "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb",
      },
      { idempotencyKey: "with-id" },
    );
    await client.capture(
      { event: "without-id" },
      { idempotencyKey: "without-id" },
    );

    expect(JSON.parse(bodies[0]!)).toHaveProperty(
      "event_id",
      "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb",
    );
    expect(JSON.parse(bodies[1]!)).not.toHaveProperty("event_id");
  });

  it.each(["database", "", "SERVER", 1, null])(
    "rejects invalid span_kind %j",
    async (span_kind) => {
      const client = clientWith(async () => success());
      await expect(
        client.capture(
          { event: "span", span_kind } as unknown as TrafficWarEvent,
          { idempotencyKey: "bad-span" },
        ),
      ).rejects.toMatchObject({ path: "event.span_kind" });
    },
  );

  it.each(["user_id", "service", "service_id"])(
    "rejects token-derived field %s",
    async (field) => {
      const client = clientWith(async () => success());
      await expect(
        client.capture(
          { event: "identity", [field]: "forged" } as unknown as TrafficWarEvent,
          { idempotencyKey: `forbidden-${field}` },
        ),
      ).rejects.toMatchObject({ path: `event.${field}` });
    },
  );

  it("rejects non-string wire string fields", async () => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        { event: "types", trace_id: 123 } as unknown as TrafficWarEvent,
        { idempotencyKey: "bad-string" },
      ),
    ).rejects.toMatchObject({ path: "event.trace_id" });
  });

  it("accepts nested JSON values in properties", async () => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        {
          event: "json",
          properties: {
            nullable: null,
            scalar: true,
            nested: [1, "two", { three: false }],
          },
        },
        { idempotencyKey: "json-values" },
      ),
    ).resolves.toMatchObject({ accepted: 1 });
  });

  it("rejects circular JSON", async () => {
    const properties: Record<string, unknown> = {};
    properties.self = properties;
    const client = clientWith(async () => success());

    await expect(
      client.capture(
        { event: "circular", properties } as unknown as TrafficWarEvent,
        { idempotencyKey: "circular-1" },
      ),
    ).rejects.toMatchObject({
      name: "TrafficWarValidationError",
      idempotencyKey: "circular-1",
    });
  });

  it.each([
    { value: 1n, label: "BigInt" },
    { value: undefined, label: "undefined" },
    { value: new Date(), label: "Date" },
    { value: new Map(), label: "Map" },
  ])("rejects non-JSON property value $label", async ({ value }) => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        {
          event: "not-json",
          properties: { value },
        } as unknown as TrafficWarEvent,
        { idempotencyKey: "not-json" },
      ),
    ).rejects.toBeInstanceOf(TrafficWarValidationError);
  });

  it("converts serialization getter failures to validation errors", async () => {
    let reads = 0;
    const properties = Object.defineProperty({}, "unstable", {
      enumerable: true,
      get() {
        reads += 1;
        if (reads > 1) {
          throw new Error("getter failed");
        }
        return "first";
      },
    });
    const client = clientWith(async () => success());

    await expect(
      client.capture(
        { event: "getter", properties } as TrafficWarEvent,
        { idempotencyKey: "getter-1" },
      ),
    ).rejects.toBeInstanceOf(TrafficWarValidationError);
  });
});

describe("TrafficWar batch and request validation", () => {
  it.each([null, {}, "events", [], 42])(
    "rejects invalid or empty batches: %j",
    async (events) => {
      const fetch = vi.fn(async () => success());
      const client = clientWith(fetch);
      await expect(
        client.captureBatch(events as unknown as TrafficWarEvent[], {
          idempotencyKey: "bad-batch",
        }),
      ).rejects.toBeInstanceOf(TrafficWarValidationError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects more than 10,000 events before serialization", async () => {
    const fetch = vi.fn(async () => success());
    const client = clientWith(fetch);
    const event = { event: "over" };
    const events = Array.from(
      { length: TRAFFICWAR_MAX_BATCH_SIZE + 1 },
      () => event,
    );

    await expect(
      client.captureBatch(events, { idempotencyKey: "too-many" }),
    ).rejects.toMatchObject({ path: "events" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the failing batch index", async () => {
    const client = clientWith(async () => success(2));
    await expect(
      client.captureBatch(
        [
          { event: "valid" },
          { event: "", latency_ms: 1 },
        ],
        { idempotencyKey: "indexed" },
      ),
    ).rejects.toMatchObject({ path: "events[1].event" });
  });

  it("rejects duplicate event IDs in one batch", async () => {
    const event_id = "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb";
    const client = clientWith(async () => success(2));
    await expect(
      client.captureBatch(
        [
          { event: "one", event_id },
          { event: "two", event_id },
        ],
        { idempotencyKey: "duplicate" },
      ),
    ).rejects.toMatchObject({ path: "events[1].event_id" });
  });

  it.each([
    "",
    "contains space",
    "\ttab",
    "é",
    "x".repeat(257),
  ])("rejects invalid custom idempotency key", async (idempotencyKey) => {
    const fetch = vi.fn(async () => success());
    const client = clientWith(fetch);
    await expect(
      client.capture(
        { event: "key" },
        { idempotencyKey },
      ),
    ).rejects.toMatchObject({ path: "options.idempotencyKey" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a non-AbortSignal signal", async () => {
    const client = clientWith(async () => success());
    await expect(
      client.capture(
        { event: "signal" },
        {
          idempotencyKey: "signal-1",
          signal: {} as AbortSignal,
        },
      ),
    ).rejects.toMatchObject({
      path: "options.signal",
      idempotencyKey: "signal-1",
    });
  });

  it("enforces the 8 MiB decoded body limit before gzip", async () => {
    const fetch = vi.fn(async () => success());
    const client = new TrafficWar({
      apiKey: "tw_decoded_limit",
      compression: "gzip",
      fetch,
    });

    await expect(
      client.capture(
        {
          event: "too-large",
          properties: {
            payload: "x".repeat(TRAFFICWAR_MAX_DECODED_BODY_BYTES),
          },
        },
        { idempotencyKey: "decoded-limit" },
      ),
    ).rejects.toThrow(
      `Decoded request body exceeds ${TRAFFICWAR_MAX_DECODED_BODY_BYTES} bytes`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces the 2 MiB wire limit in identity mode", async () => {
    const fetch = vi.fn(async () => success());
    const client = new TrafficWar({
      apiKey: "tw_wire_limit",
      compression: "none",
      fetch,
    });

    await expect(
      client.capture(
        {
          event: "too-large",
          properties: {
            payload: "x".repeat(TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES),
          },
        },
        { idempotencyKey: "wire-limit" },
      ),
    ).rejects.toThrow(/wire limit/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
