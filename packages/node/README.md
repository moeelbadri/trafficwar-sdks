# @trafficwar/node

Official, dependency-free TrafficWar server SDK for Node.js 22 and newer.

## Install

```sh
npm install @trafficwar/node
```

## Capture an event

```ts
import { TrafficWar } from "@trafficwar/node";

const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
});

const result = await trafficwar.capture({
  event: "checkout.completed",
  event_id: "018f47a2-7b17-7b9f-8a9c-5b1fdbda7b31",
  timestamp: new Date(),
  latency_ms: 184.2,
  status_code: 200,
  span_kind: "server",
  operation_type: "http",
  properties: {
    orderId: "ord_123",
    total: 49.95,
  },
});

console.log(result.ingestId, result.accepted, result.idempotencyKey);
```

`Date` timestamps are serialized as RFC3339 without changing the caller's
object. String timestamps must be RFC3339; numeric timestamps are integer epoch
milliseconds.

The SDK does not generate `event_id`. You may provide a UUID, or omit it and
let TrafficWar derive a stable ID from the request's idempotency receipt.
`user_id`, `service`, and `service_id` must not be sent: TrafficWar derives
identity from the API key.

## Capture a batch

```ts
await trafficwar.captureBatch([
  { event: "job.started", trace_id: "trace-123" },
  { event: "job.finished", trace_id: "trace-123", latency_ms: 42 },
]);
```

Batches must contain 1 to 10,000 events. The SDK sends the required bare JSON
array to `/v1/server/batch`; a single capture sends one JSON object to
`/v1/server/capture`.

## Request options

Every SDK call creates a fresh idempotency key. The exact JSON bytes, optional
gzip bytes, and key are created once and reused across that call's retries.
Supply your own key when retry coordination must survive a process boundary:

```ts
const controller = new AbortController();

await trafficwar.capture(
  { event: "invoice.created" },
  {
    idempotencyKey: "invoice-inv_123-v1",
    signal: controller.signal,
  },
);
```

An idempotency key must contain 1-256 visible ASCII characters. A key is scoped
to the service represented by the API key and is body- and route-sensitive.
Reusing a key for a different request produces HTTP 409 and is never retried.

## Client options

- `apiKey` (required): TrafficWar server API key.
- `baseUrl`: ingest origin. Defaults to `https://ingest.trafficwar.tech`.
- `timeoutMs`: timeout for each attempt. Defaults to 30,000 ms, safely above
  TrafficWar's 10-second durable acknowledgement window.
- `maxRetries`: retries after the first attempt. Defaults to 3.
- `compression`: `"auto"`, `"gzip"`, or `"none"`. Defaults to `"auto"`.
- `compressionThresholdBytes`: gzip threshold in auto mode. Defaults to 1024.
- `fetch`: injected Fetch-compatible function, primarily for testing.

The SDK sends `Content-Type: application/json`, `Authorization: Bearer ...`, a
server SDK User-Agent, and `x-trafficwar-sdk`. It never sends `Origin`.

Decoded JSON is limited to 8 MiB. The identity or gzip wire body is limited to
2 MiB. Auto mode gzip-compresses bodies at or above the configured threshold.

## Retries and errors

Transport failures, per-attempt timeouts, and HTTP 408, 425, 500, 502, 503, and
504 use exponential full jitter. `Retry-After` is honored as a minimum delay
up to 60 seconds; larger values are surfaced immediately as API errors so calls
remain bounded. HTTP 409 and 429 are never retried.

```ts
import {
  TrafficWarApiError,
  TrafficWarConnectionError,
  TrafficWarProtocolError,
  TrafficWarRateLimitError,
  TrafficWarValidationError,
} from "@trafficwar/node";

try {
  await trafficwar.capture({ event: "task.failed", status_code: 500 });
} catch (error) {
  if (error instanceof TrafficWarRateLimitError) {
    console.error(error.period, error.remainingEvents, error.retryAfterSeconds);
  } else if (error instanceof TrafficWarApiError) {
    console.error(error.status, error.ingestId, error.details);
  } else if (error instanceof TrafficWarConnectionError) {
    console.error(error.timedOut, error.attempts, error.idempotencyKey);
  } else if (
    error instanceof TrafficWarProtocolError ||
    error instanceof TrafficWarValidationError
  ) {
    console.error(error.message);
  }
}
```

Request errors retain the idempotency key. HTTP and protocol errors also retain
the status, parsed response details, `Retry-After` as `retryAfterSeconds`, and
the ingest ID when supplied by TrafficWar. Rate-limit errors additionally map
`period`, `used`, `limit`, `remainingEvents`, `batchEvents`, and
`retryAfterSecs`.

CommonJS is also supported:

```js
const { TrafficWar } = require("@trafficwar/node");
```

## License

MIT
