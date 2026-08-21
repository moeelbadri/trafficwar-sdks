import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { node } from "@elysiajs/node";
import {
  TrafficWarError,
  type TrafficWar,
} from "@trafficwar/node";
import { Elysia } from "elysia";

interface GreetingRow {
  id: number;
  name: string;
  message: string;
}

function openGreetingStore(): {
  findByName(name: string): GreetingRow | undefined;
  close(): void;
} {
  const database = new DatabaseSync(":memory:");

  try {
    database.exec(`
      CREATE TABLE greetings (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        message TEXT NOT NULL
      );
      INSERT INTO greetings (name, message)
      VALUES ('Ada', 'Hello, Ada!'), ('Grace', 'Hello, Grace!');
    `);
    const selectGreeting = database.prepare(
      "SELECT id, name, message FROM greetings WHERE name = ?",
    );
    let closed = false;

    return {
      findByName(name) {
        return selectGreeting.get(name) as unknown as GreetingRow | undefined;
      },
      close() {
        if (!closed) {
          closed = true;
          database.close();
        }
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

export function createApp(trafficwar: TrafficWar) {
  const greetings = openGreetingStore();
  const app = new Elysia({ adapter: node() })
    .onError(({ error, status }) => {
      if (error instanceof TrafficWarError) {
        console.error(error);
        return status(500, { error: "Internal server error" });
      }
      return undefined;
    })
    .get("/hello/:name", async ({ params, set }) => {
      const requestStartedAt = performance.now();
      const queryStartedAt = performance.now();
      const row = greetings.findByName(params.name);
      const queryLatencyMs = performance.now() - queryStartedAt;
      const statusCode = row ? 200 : 404;

      await trafficwar.capture({
        event: "hello.request",
        distinct_id: params.name,
        path: "/hello/:name",
        label: "GET /hello/:name",
        source: "elysia",
        span_kind: "server",
        operation_type: "sqlite.select",
        status_code: statusCode,
        latency_ms: performance.now() - requestStartedAt,
        properties: {
          row_id: row?.id ?? null,
          message: row?.message ?? null,
          query_latency_ms: queryLatencyMs,
        },
        ...(row ? {} : { error: "Greeting not found" }),
      });

      if (!row) {
        set.status = 404;
        return { error: "Greeting not found" };
      }

      return row;
    });

  return {
    app,
    close: () => greetings.close(),
  };
}
