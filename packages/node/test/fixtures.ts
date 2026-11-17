import type { TrafficWarEvent } from "../src";

// Complete explicit span input; spread at the call site so validation tests can
// override or remove individual fields without changing capture behavior.
// Keep it small so count-ceiling tests fit 10,000 spans below the wire limit.
export const validEvent = {
  event: "database",
  label: "A",
  source: "a",
  operation_type: "op",
  span_kind: "server",
  timestamp: 0,
  latency_ms: 1,
} satisfies TrafficWarEvent;

export const validHttpEvent = {
  ...validEvent,
  event: "http",
  http_method: "GET",
  status_code: 200,
} satisfies TrafficWarEvent;
