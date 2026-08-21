import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { TrafficWar } from "@trafficwar/node";

import { AppModule } from "./app.module.js";

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
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(trafficwar),
  );
  app.enableShutdownHooks();

  const port = readPort();
  try {
    await app.listen(port, "0.0.0.0");
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log(`NestJS example listening on http://localhost:${port}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
