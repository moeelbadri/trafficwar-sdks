import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import type { TrafficWar } from "@trafficwar/node";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

interface GreetingRow {
  id: number;
  name: string;
  message: string;
}

export interface ExpressExample {
  app: Express;
  close(): void;
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

export function createApp(trafficwar: TrafficWar): ExpressExample {
  const greetings = openGreetingStore();
  const app = express();
  app.disable("x-powered-by");

  app.get("/hello/:name", async (request, response) => {
    const requestStartedAt = performance.now();
    const queryStartedAt = performance.now();
    const row = greetings.findByName(request.params.name);
    const queryLatencyMs = performance.now() - queryStartedAt;
    const statusCode = row ? 200 : 404;

    await trafficwar.capture({
      event: "hello.request",
      distinct_id: request.params.name,
      path: "/hello/:name",
      label: "GET /hello/:name",
      source: "express",
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
      response.status(404).json({ error: "Greeting not found" });
      return;
    }

    response.json(row);
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }

      console.error(error);
      response.status(500).json({ error: "Internal server error" });
    },
  );

  return {
    app,
    close: () => greetings.close(),
  };
}
