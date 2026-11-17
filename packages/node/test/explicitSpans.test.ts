import { describe, expect, it, vi } from "vitest";

import { TrafficWar, TrafficWarValidationError } from "../src";
import type { TrafficWarEvent } from "../src";
import { validEvent, validHttpEvent } from "./fixtures";

function recordingClient() {
  const events: Array<Record<string, unknown>> = [];
  const pairs: Array<Record<string, unknown>> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/catalog")) {
      const payload = JSON.parse(String(init.body));
      pairs.push(...payload.captures);
      return new Response(JSON.stringify({ status: "ok", added: payload.captures.length }));
    }
    const batch = JSON.parse(Buffer.from(init.body as Uint8Array).toString());
    events.push(...batch);
    return new Response(JSON.stringify({ status: "ok", accepted: batch.length, ingest_id: "explicit" }));
  });
  const client = new TrafficWar({ apiKey: "test-explicit", compression: "none", fetch });
  return { client, events, pairs, fetch };
}

describe("public explicit span contract", () => {
  it.each(["event", "label", "source", "operation_type", "span_kind", "timestamp", "latency_ms"])(
    "requires an own value for %s rather than supplying a default",
    async field => {
      const { client, fetch } = recordingClient();
      const input: Record<string, unknown> = { ...validEvent };
      delete input[field];
      expect(() => client.capture(input as unknown as TrafficWarEvent)).toThrow(
        expect.objectContaining({ name: "TrafficWarValidationError", path: `event.${field}` }),
      );
      await expect(client.close()).resolves.toEqual({ accepted: 0, batches: [] });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["event", "label", "source", "operation_type"])(
    "rejects blank and non-string %s values",
    async field => {
      const { client, fetch } = recordingClient();
      for (const value of [undefined, null, "", " ", "\t\r\n", 42, false]) {
        expect(() => client.capture({ ...validEvent, [field]: value } as unknown as TrafficWarEvent)).toThrow(
          expect.objectContaining({ path: `event.${field}` }),
        );
      }
      await client.close();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "", " ", "SERVER", "database", 42])(
    "rejects missing or invalid span_kind %j",
    async span_kind => {
      const { client, fetch } = recordingClient();
      expect(() => client.capture({ ...validEvent, span_kind } as unknown as TrafficWarEvent)).toThrow(
        expect.objectContaining({ path: "event.span_kind" }),
      );
      await client.close();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "", " ", -1, -0.001, NaN, Infinity, -Infinity, "1"])(
    "rejects missing, non-number, negative or non-finite latency %j",
    async latency_ms => {
      const { client, fetch } = recordingClient();
      expect(() => client.capture({ ...validEvent, latency_ms } as unknown as TrafficWarEvent)).toThrow(
        expect.objectContaining({ path: "event.latency_ms" }),
      );
      await client.close();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("accepts all span kinds, zero/fractional latency, and optional trace IDs without rewriting values", async () => {
    const { client, events } = recordingClient();
    client.capture([
      { ...validEvent, span_kind: "server", latency_ms: 0 },
      { ...validEvent, span_kind: "client", latency_ms: 0.125, trace_id: "shared-trace" },
      { ...validEvent, span_kind: "internal", event: " Custom ", label: " Checkout ", source: " backend-a ", operation_type: " route.handler " },
      { ...validEvent, span_kind: "producer" },
      { ...validEvent, span_kind: "consumer" },
    ]);
    expect((await client.close()).accepted).toBe(5);
    expect(events[0]).not.toHaveProperty("trace_id");
    expect(events[0]).toMatchObject({ timestamp: validEvent.timestamp, latency_ms: 0, span_kind: "server" });
    expect(events[1]).toMatchObject({ latency_ms: 0.125, trace_id: "shared-trace", span_kind: "client" });
    expect(events[2]).toMatchObject({ event: " Custom ", label: " Checkout ", source: " backend-a ", operation_type: " route.handler ", span_kind: "internal" });
    expect(events[3]!.span_kind).toBe("producer");
    expect(events[4]!.span_kind).toBe("consumer");
  });

  it.each(["http", "HTTP", " hTtP\t"])("requires http_method for %j", async event => {
    const { client, fetch } = recordingClient();
    expect(() => client.capture({ ...validEvent, event, status_code: 200 })).toThrow(
      expect.objectContaining({ path: "event.http_method" }),
    );
    await client.close();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["http", " HTTP ", "external", " EXTERNAL "])(
    "requires an HTTP outcome for %j with a method",
    async event => {
      const { client, fetch } = recordingClient();
      for (const outcome of [{}, { error: "" }, { error_code: " \t" }, { error: " ", error_code: "\n" }]) {
        expect(() => client.capture({ ...validEvent, event, http_method: "GET", ...outcome })).toThrow(TrafficWarValidationError);
      }
      await client.close();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["http", " HTTP ", "external", " EXTERNAL "])(
    "accepts %j HTTP responses or network failures without inventing a status",
    async event => {
      const { client, events } = recordingClient();
      client.capture([
        { ...validEvent, event, http_method: "get", status_code: 200 },
        { ...validEvent, event, http_method: "POST", status_code: 503 },
        { ...validEvent, event, http_method: "GET", error: "connection reset" },
        { ...validEvent, event, http_method: "GET", error_code: "ETIMEDOUT" },
      ]);
      expect((await client.close()).accepted).toBe(4);
      expect(events[0]).toMatchObject({ event, http_method: "GET", status_code: 200 });
      expect(events[1]).toMatchObject({ status_code: 503 });
      expect(events[2]).toMatchObject({ error: "connection reset" });
      expect(events[3]).toMatchObject({ error_code: "ETIMEDOUT" });
      expect(events[2]).not.toHaveProperty("status_code");
      expect(events[3]).not.toHaveProperty("status_code");
    },
  );

  it("does not require an HTTP outcome for non-HTTP work, and preserves status range boundaries", async () => {
    const { client, events } = recordingClient();
    client.capture([
      { ...validEvent, event: "external", span_kind: "client" },
      { ...validEvent, event: "database" },
      { ...validHttpEvent, status_code: 0 },
      { ...validHttpEvent, status_code: 65_535 },
    ]);
    expect((await client.close()).accepted).toBe(4);
    expect(events[0]).not.toHaveProperty("http_method");
    expect(events[0]).not.toHaveProperty("status_code");
    expect(events[2]!.status_code).toBe(0);
    expect(events[3]!.status_code).toBe(65_535);
  });

  it.each(["capture", "captureBatch"] as const)(
    "%s rejects an invalid batch atomically without learning pairs or reserving IDs",
    async method => {
      const { client, events, pairs, fetch } = recordingClient();
      const event_id = "550e8400-e29b-41d4-a716-446655440000";
      const staged = { ...validEvent, event_id, label: "Must not stage" };
      expect(() => client[method]([
        staged,
        { ...validEvent, latency_ms: -1, label: "Invalid span" },
      ])).toThrow(expect.objectContaining({ path: "events[1].latency_ms" }));
      expect(fetch).not.toHaveBeenCalled();
      await expect(client.flush()).resolves.toEqual({ accepted: 0, batches: [] });
      expect(events).toEqual([]);
      expect(pairs).toEqual([]);
      client.capture({ ...staged, label: "Accepted later" });
      expect((await client.close()).accepted).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event_id, label: "Accepted later" });
      expect(pairs).toEqual([{ event: "database", label: "Accepted later", station_known: false }]);
    },
  );
});
