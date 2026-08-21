import { createServer, type Server } from "node:http";

import { TrafficWar } from "@trafficwar/node";

import { createApp } from "./app.js";

function readPort(): number {
  const value = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return value;
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

async function main(): Promise<void> {
  const apiKey = process.env.TRAFFICWAR_API_KEY;
  if (!apiKey) {
    throw new Error("TRAFFICWAR_API_KEY is required");
  }

  const baseUrl = process.env.TRAFFICWAR_BASE_URL;
  const trafficwar = new TrafficWar({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  });
  const example = createApp(trafficwar);
  const server = createServer(example.app);
  const port = readPort();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    example.close();
    throw error;
  }

  console.log(`Express example listening on http://localhost:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);

    try {
      await closeServer(server);
    } finally {
      example.close();
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
