import assert from "node:assert/strict";
import test from "node:test";

import {
  TrafficWar,
  type TrafficWarFetch,
} from "@trafficwar/node";

import { createApp } from "../src/app.js";

type CapturedEvent = Record<string, unknown>;

function createTestClient(): {
  trafficwar: TrafficWar;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const fakeFetch: TrafficWarFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://ingest.test");
    assert.equal(url.pathname, "/v1/server/capture");
    assert.equal(init.method, "POST");

    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer test-api-key");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.has("origin"), false);
    assert.equal(headers.has("content-encoding"), false);
    assert.ok(init.body instanceof Uint8Array);

    const payload: unknown = JSON.parse(
      Buffer.from(init.body).toString("utf8"),
    );
    assert.equal(typeof payload, "object");
    assert.notEqual(payload, null);
    assert.equal(Array.isArray(payload), false);
    events.push(payload as CapturedEvent);

    return new Response(
      JSON.stringify({
        status: "ok",
        accepted: 1,
        ingest_id: `test-ingest-${events.length}`,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  return {
    trafficwar: new TrafficWar({
      apiKey: "test-api-key",
      baseUrl: "https://ingest.test",
      fetch: fakeFetch,
      timeoutMs: 1_000,
      maxRetries: 0,
      compression: "none",
    }),
    events,
  };
}

function assertCommonEvent(
  event: CapturedEvent,
  expectedStatus: number,
): void {
  assert.equal(event.event, "hello.request");
  assert.equal(event.path, "/hello/:name");
  assert.equal(event.label, "GET /hello/:name");
  assert.equal(event.source, "elysia");
  assert.equal(event.span_kind, "server");
  assert.equal(event.operation_type, "sqlite.select");
  assert.equal(event.status_code, expectedStatus);
  assert.equal(typeof event.latency_ms, "number");
  assert.ok(Number.isFinite(event.latency_ms));
}

test("queries SQLite and captures successful and missing greetings", async () => {
  const { trafficwar, events } = createTestClient();
  const example = createApp(trafficwar);

  try {
    const adaResponse = await example.app.handle(
      new Request("http://localhost/hello/Ada"),
    );
    assert.equal(adaResponse.status, 200);
    assert.deepEqual(await adaResponse.json(), {
      id: 1,
      name: "Ada",
      message: "Hello, Ada!",
    });

    assert.equal(events.length, 1);
    const success = events[0]!;
    assertCommonEvent(success, 200);
    assert.equal(success.distinct_id, "Ada");
    assert.equal(success.error, undefined);
    const successProperties = success.properties as CapturedEvent;
    assert.equal(successProperties.row_id, 1);
    assert.equal(successProperties.message, "Hello, Ada!");
    assert.equal(typeof successProperties.query_latency_ms, "number");
    assert.ok(Number.isFinite(successProperties.query_latency_ms));

    const missingResponse = await example.app.handle(
      new Request("http://localhost/hello/Unknown"),
    );
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), {
      error: "Greeting not found",
    });

    assert.equal(events.length, 2);
    const missing = events[1]!;
    assertCommonEvent(missing, 404);
    assert.equal(missing.distinct_id, "Unknown");
    assert.equal(missing.error, "Greeting not found");
    const missingProperties = missing.properties as CapturedEvent;
    assert.equal(missingProperties.row_id, null);
    assert.equal(missingProperties.message, null);
  } finally {
    example.close();
  }
});

test("returns a generic 500 when TrafficWar rejects a capture", async (context) => {
  context.mock.method(console, "error", () => {});
  const trafficwar = new TrafficWar({
    apiKey: "test-api-key",
    baseUrl: "https://ingest.test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          status: "error",
          error: "private upstream quota detail",
          period: "monthly",
        }),
        {
          status: 429,
          headers: { "content-type": "application/json" },
        },
      ),
    timeoutMs: 1_000,
    maxRetries: 0,
    compression: "none",
  });
  const example = createApp(trafficwar);

  try {
    const response = await example.app.handle(
      new Request("http://localhost/hello/Ada"),
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Internal server error",
    });
  } finally {
    example.close();
  }
});
