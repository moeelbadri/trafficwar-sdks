import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  Inject,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { TrafficWar } from "@trafficwar/node";

import { TRAFFICWAR } from "./trafficwar.provider.js";

export interface Greeting {
  id: number;
  name: string;
  message: string;
}

@Injectable()
export class GreetingService implements OnModuleDestroy {
  readonly #database: DatabaseSync;
  readonly #findByName: (name: string) => Greeting | undefined;
  #closed = false;

  constructor(@Inject(TRAFFICWAR) private readonly trafficwar: TrafficWar) {
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

      this.#database = database;
      this.#findByName = (name) =>
        selectGreeting.get(name) as unknown as Greeting | undefined;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  findGreeting(name: string): Greeting | undefined {
    const requestStartedAt = performance.now();
    const queryStartedAt = performance.now();
    const row = this.#findByName(name);
    const queryLatencyMs = performance.now() - queryStartedAt;
    const statusCode = row ? 200 : 404;

    this.trafficwar.capture({
      event: "hello.request",
      distinct_id: name,
      path: "/hello/:name",
      label: "GET /hello/:name",
      source: "nestjs",
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

    return row;
  }

  onModuleDestroy(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#database.close();
    }
  }
}
