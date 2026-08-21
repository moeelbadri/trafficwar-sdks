import { TrafficWar } from "@trafficwar/node";

import { createApp } from "./app.js";

function readPort(): number {
  const value = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return value;
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
  const port = readPort();

  try {
    await example.app.listen({ hostname: "0.0.0.0", port });
  } catch (error) {
    example.close();
    throw error;
  }

  console.log(`Elysia example listening on http://localhost:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);

    try {
      await example.app.stop();
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
