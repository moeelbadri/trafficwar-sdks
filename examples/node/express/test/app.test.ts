import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
  let requests = 0;
  const fakeFetch: TrafficWarFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://ingest.test");
    assert.equal(url.pathname, "/v1/server/batch");
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
    assert.ok(Array.isArray(payload));
    assert.ok(payload.length > 0);
    for (const item of payload) {
      assert.equal(typeof item, "object");
      assert.notEqual(item, null);
      assert.equal(Array.isArray(item), false);
      const event = item as CapturedEvent;
      assert.match(
        String(event.event_id),
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      events.push(event);
    }
    requests += 1;

    return new Response(
      JSON.stringify({
        status: "ok",
        accepted: payload.length,
        ingest_id: `test-ingest-${requests}`,
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
      flushIntervalMs: 60_000,
    }),
    events,
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function assertCommonEvent(
  event: CapturedEvent,
  expectedStatus: number,
): void {
  assert.equal(event.event, "http");
  assert.equal(event.path, "/hello/:name");
  assert.equal(event.http_method, "GET");
  assert.equal(event.label, "GET /hello/:name");
  assert.equal(event.source, "backend-1");
  assert.equal(event.span_kind, "server");
  assert.equal(event.operation_type, "route.handler");
  assert.equal(event.status_code, expectedStatus);
  assert.equal(typeof event.latency_ms, "number");
  assert.ok(Number.isFinite(event.latency_ms));
}

test("queries SQLite and captures successful and missing greetings", async () => {
  const { trafficwar, events } = createTestClient();
  const example = createApp(trafficwar);
  const server = createServer(example.app);

  await listen(server);
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const adaResponse = await fetch(`${baseUrl}/hello/Ada`);
    assert.equal(adaResponse.status, 200);
    assert.deepEqual(await adaResponse.json(), {
      id: 1,
      name: "Ada",
      message: "Hello, Ada!",
    });

    const successFlush = await trafficwar.flush();
    assert.equal(successFlush.accepted, 1);
    assert.equal(successFlush.batches.length, 1);
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

    const missingResponse = await fetch(`${baseUrl}/hello/Unknown`);
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), {
      error: "Greeting not found",
    });

    const missingFlush = await trafficwar.flush();
    assert.equal(missingFlush.accepted, 1);
    assert.equal(missingFlush.batches.length, 1);
    assert.equal(events.length, 2);
    const missing = events[1]!;
    assertCommonEvent(missing, 404);
    assert.equal(missing.distinct_id, "Unknown");
    assert.equal(missing.error, "Greeting not found");
    const missingProperties = missing.properties as CapturedEvent;
    assert.equal(missingProperties.row_id, null);
    assert.equal(missingProperties.message, null);
  } finally {
    await closeServer(server);
    try {
      await trafficwar.close();
    } finally {
      example.close();
    }
  }
});
