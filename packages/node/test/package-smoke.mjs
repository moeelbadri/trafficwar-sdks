import assert from "node:assert/strict";
import { createRequire } from "node:module";

const esm = await import("@trafficwar/node");
const cjs = createRequire(import.meta.url)("@trafficwar/node");

for (const sdk of [esm, cjs]) {
  assert.equal(typeof sdk.TrafficWar, "function");
  assert.equal(typeof sdk.TrafficWarError, "function");
  assert.equal(sdk.TRAFFICWAR_DEFAULT_FLUSH_INTERVAL_MS, 1_000);
  assert.equal(sdk.TRAFFICWAR_DEFAULT_MAX_QUEUE_SIZE, 100_000);
}
