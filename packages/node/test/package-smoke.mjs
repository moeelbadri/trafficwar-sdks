import assert from "node:assert/strict";
import { createRequire } from "node:module";

const esm = await import("@trafficwar/node");
const cjs = createRequire(import.meta.url)("@trafficwar/node");

for (const sdk of [esm, cjs]) {
  assert.equal(typeof sdk.TrafficWar, "function");
  assert.equal(typeof sdk.TrafficWarError, "function");
}
