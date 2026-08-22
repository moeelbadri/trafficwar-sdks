import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TrafficWar,
  TrafficWarValidationError,
  TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES,
  TRAFFICWAR_MAX_DECODED_BODY_BYTES,
} from "../src";
import type {
  TrafficWarEvent,
  TrafficWarFetch,
  TrafficWarOptions,
} from "../src";

function bodyEvents(init: RequestInit): Array<Record<string, unknown>> {
  if (!(init.body instanceof Uint8Array)) {
    throw new Error("unexpected body");
  }
  return JSON.parse(Buffer.from(init.body).toString()) as Array<
    Record<string, unknown>
  >;
}

function success(init: RequestInit): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      accepted: bodyEvents(init).length,
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

afterEach(() => {
  vi.useRealTimers();
});

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
            fetch: async (_url, init) => success(init),
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
          fetch: async (_url, init) => success(init),
        }),
    ).toThrow(/baseUrl/);
  });

  it("accepts URL objects and canonicalizes trailing slashes", () => {
    const client = new TrafficWar({
      apiKey: "tw_key",
      baseUrl: new URL("https://example.com///"),
      fetch: async (_url, init) => success(init),
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
    { flushIntervalMs: 0 },
    { flushIntervalMs: 1.5 },
    { maxQueueSize: 0 },
    { maxQueueSize: 1.5 },
    { compression: "brotli" },
    { debug: "yes" },
    { fetch: "not-fetch" },
    { onError: "not-callback" },
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
    {},
    { event: "" },
    { event: "   " },
    { event: 42 },
  ])("rejects invalid capture input: %j", (event) => {
    const fetch = vi.fn(async (_url, init) => success(init));
    const client = clientWith(fetch);

    expect(() =>
      client.capture(event as unknown as TrafficWarEvent),
    ).toThrow(TrafficWarValidationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite latency %s",
    (latency_ms) => {
      const client = clientWith(async (_url, init) => success(init));
      expect(() =>
        client.capture({ event: "latency", latency_ms }),
      ).toThrow(
        expect.objectContaining({
          name: "TrafficWarValidationError",
          path: "event.latency_ms",
        }),
      );
    },
  );

  it.each([-1, 65_536, 1.5, Number.NaN, "500"])(
    "rejects invalid status_code %s",
    (status_code) => {
      const client = clientWith(async (_url, init) => success(init));
      expect(() =>
        client.capture({
          event: "status",
          status_code,
        } as unknown as TrafficWarEvent),
      ).toThrow(expect.objectContaining({ path: "event.status_code" }));
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
  ])("rejects invalid timestamps", (timestamp) => {
    const client = clientWith(async (_url, init) => success(init));
    expect(() =>
      client.capture({
        event: "timestamp",
        timestamp,
      } as unknown as TrafficWarEvent),
    ).toThrow(expect.objectContaining({ path: "event.timestamp" }));
  });

  it.each([
    "2026-08-21T12:30:00Z",
    "2026-08-21T12:30:00.123456+02:00",
    "2024-02-29T23:59:59.123456789-05:30",
    1_776_771_000_000,
  ])("accepts timestamp value %s", async (timestamp) => {
    const client = clientWith(async (_url, init) => success(init));
    expect(() =>
      client.capture({ event: "timestamp", timestamp }),
    ).not.toThrow();
    await expect(client.flush()).resolves.toMatchObject({ accepted: 1 });
  });

  it.each([
    "",
    "not-a-uuid",
    "0190b0d0-acbd-7a2d-9bc",
    "0190b0d0acbd7a2d9bc09a36b7e269fb",
  ])("rejects invalid event_id %s", (event_id) => {
    const client = clientWith(async (_url, init) => success(init));
    expect(() =>
      client.capture({ event: "id", event_id }),
    ).toThrow(expect.objectContaining({ path: "event.event_id" }));
  });

  it.each(["database", "", "SERVER", 1, null])(
    "rejects invalid span_kind %j",
    (span_kind) => {
      const client = clientWith(async (_url, init) => success(init));
      expect(() =>
        client.capture({
          event: "span",
          span_kind,
        } as unknown as TrafficWarEvent),
      ).toThrow(expect.objectContaining({ path: "event.span_kind" }));
    },
  );

  it.each(["user_id", "service", "service_id"])(
    "rejects token-derived field %s",
    (field) => {
      const client = clientWith(async (_url, init) => success(init));
      expect(() =>
        client.capture({
          event: "identity",
          [field]: "forged",
        } as unknown as TrafficWarEvent),
      ).toThrow(expect.objectContaining({ path: `event.${field}` }));
    },
  );

  it("rejects non-string wire string fields", () => {
    const client = clientWith(async (_url, init) => success(init));
    expect(() =>
      client.capture({
        event: "types",
        trace_id: 123,
      } as unknown as TrafficWarEvent),
    ).toThrow(expect.objectContaining({ path: "event.trace_id" }));
  });

  it("accepts and snapshots nested JSON values in properties", async () => {
    let sent: Array<Record<string, unknown>> = [];
    const client = clientWith(async (_url, init) => {
      sent = bodyEvents(init);
      return success(init);
    });
    const nested: Array<number | string | { three: boolean }> = [
      1,
      "two",
      { three: false },
    ];
    client.capture({
      event: "json",
      properties: {
        nullable: null,
        scalar: true,
        nested,
      },
    });
    nested.push("late");

    await client.flush();
    expect(sent[0]?.properties).toEqual({
      nullable: null,
      scalar: true,
      nested: [1, "two", { three: false }],
    });
  });

  it("rejects circular JSON synchronously", () => {
    const properties: Record<string, unknown> = {};
    properties.self = properties;
    const client = clientWith(async (_url, init) => success(init));

    expect(() =>
      client.capture({
        event: "circular",
        properties,
      } as unknown as TrafficWarEvent),
    ).toThrow(TrafficWarValidationError);
  });

  it.each([
    { value: 1n, label: "BigInt" },
    { value: undefined, label: "undefined" },
    { value: new Date(), label: "Date" },
    { value: new Map(), label: "Map" },
  ])("rejects non-JSON property value $label", ({ value }) => {
    const client = clientWith(async (_url, init) => success(init));
    expect(() =>
      client.capture({
        event: "not-json",
        properties: { value },
      } as unknown as TrafficWarEvent),
    ).toThrow(TrafficWarValidationError);
  });

  it("reads nested getters once while taking the snapshot", async () => {
    let reads = 0;
    const properties = Object.defineProperty({}, "stable", {
      enumerable: true,
      get() {
        reads += 1;
        return `read-${reads}`;
      },
    });
    let sent: Array<Record<string, unknown>> = [];
    const client = clientWith(async (_url, init) => {
      sent = bodyEvents(init);
      return success(init);
    });

    client.capture({
      event: "getter",
      properties,
    } as TrafficWarEvent);
    expect(reads).toBe(1);
    await client.flush();

    expect(reads).toBe(1);
    expect(sent[0]?.properties).toEqual({ stable: "read-1" });
  });
});

describe("TrafficWar array and queue validation", () => {
  it.each([null, {}, { event: "not-a-batch" }, "events", [], 42])(
    "rejects invalid or empty captureBatch input: %j",
    (events) => {
      const fetch = vi.fn(async (_url, init) => success(init));
      const client = clientWith(fetch);

      expect(() =>
        client.captureBatch(
          events as unknown as readonly TrafficWarEvent[],
        ),
      ).toThrow(TrafficWarValidationError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports the failing array index", () => {
    const client = clientWith(async (_url, init) => success(init));
    expect(() =>
      client.capture([
        { event: "valid" },
        { event: "", latency_ms: 1 },
      ]),
    ).toThrow(expect.objectContaining({ path: "events[1].event" }));
  });

  it("reports a sparse event array at its first missing index", () => {
    const fetch = vi.fn(async (_url, init) => success(init));
    const client = clientWith(fetch);
    const events = new Array<TrafficWarEvent>(3);
    events[0] = { event: "first" };
    events[2] = { event: "third" };

    expect(() => client.capture(events)).toThrow(
      expect.objectContaining({
        name: "TrafficWarValidationError",
        path: "events[1]",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects duplicate caller event IDs in one enqueue", () => {
    const event_id = "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb";
    const client = clientWith(async (_url, init) => success(init));

    expect(() =>
      client.capture([
        { event: "one", event_id },
        { event: "two", event_id },
      ]),
    ).toThrow(
      expect.objectContaining({ path: "events[1].event_id" }),
    );
  });

  it("rejects pending IDs atomically and allows reuse after acknowledgement", async () => {
    const pendingId = "0190b0d0-acbd-7a2d-9bc0-9a36b7e269fb";
    const stagedId = "550e8400-e29b-41d4-a716-446655440000";
    const calls: RequestInit[] = [];
    const client = clientWith(async (_url, init) => {
      calls.push(init);
      return success(init);
    });
    client.capture({ event: "pending", event_id: pendingId });

    expect(() =>
      client.capture([
        { event: "must-not-stage", event_id: stagedId },
        { event: "duplicate", event_id: pendingId },
      ]),
    ).toThrow(
      expect.objectContaining({ path: "events[1].event_id" }),
    );

    await expect(client.flush()).resolves.toMatchObject({ accepted: 1 });
    expect(bodyEvents(calls[0]!)).toMatchObject([
      { event: "pending", event_id: pendingId },
    ]);

    expect(() =>
      client.capture([
        { event: "reuse-delivered", event_id: pendingId },
        { event: "atomic-id-was-not-reserved", event_id: stagedId },
      ]),
    ).not.toThrow();
    await expect(client.flush()).resolves.toMatchObject({ accepted: 2 });
  });

  it("rejects an enqueue that would exceed the configured queue cap atomically", async () => {
    const calls: RequestInit[] = [];
    const client = new TrafficWar({
      apiKey: "tw_atomic_cap",
      compression: "none",
      maxQueueSize: 3,
      fetch: async (_url, init) => {
        calls.push(init);
        return success(init);
      },
    });
    client.capture([{ event: "one" }, { event: "two" }]);

    expect(() =>
      client.capture([{ event: "three" }, { event: "four" }]),
    ).toThrow(expect.objectContaining({ path: "queue" }));

    const result = await client.flush();
    expect(result.accepted).toBe(2);
    expect(bodyEvents(calls[0]!)).toHaveLength(2);
  });

  it("retains a single event that exceeds the wire limit and surfaces it from flush", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url, init) => success(init));
    const client = new TrafficWar({
      apiKey: "tw_wire_limit",
      compression: "none",
      fetch,
    });
    client.capture({
      event: "too-large",
      properties: {
        payload: "x".repeat(TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES),
      },
    });

    await expect(client.flush()).rejects.toMatchObject({
      name: "TrafficWarValidationError",
      path: "body",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
