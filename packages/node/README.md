# @trafficwar/node

Official, dependency-free TrafficWar server SDK for Node.js 22 and newer.

> **Breaking change in 2.0.0:** `capture` now enqueues events for automatic
> batching instead of waiting for an individual ingestion response.

## Install

```sh
npm install @trafficwar/node
```

## Capture events

```ts
import { TrafficWar } from "@trafficwar/node";

const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
  onError(error) {
    console.error("TrafficWar automatic flush failed", error);
  },
});

trafficwar.capture({
  event: "checkout.completed",
  timestamp: new Date(),
  latency_ms: 184.2,
  status_code: 200,
  source: "checkout-api",
  properties: {
    orderId: "ord_123",
    total: 49.95,
  },
});

trafficwar.capture([
  { event: "job.started", source: "worker" },
  { event: "job.finished", source: "worker", latency_ms: 42 },
]);
```

`capture` accepts one event or a non-empty array. It validates, snapshots, and
enqueues the input synchronously, then returns `void`; it does not return an
`IngestResult` or wait for the network.

`Date` timestamps are serialized as RFC3339 without changing the caller's
object. String timestamps must be RFC3339; numeric timestamps are integer epoch
milliseconds.

## Automatic batching

The first queued event starts a one-second timer. The client flushes when that
timer expires or as soon as 10,000 events are pending. TrafficWar's fixed
server batch maximum is 10,000, so a larger queued array is split across
requests.

Every request is a bare JSON array sent to `/v1/server/batch`, including a
single-event capture. The queue holds at most 100,000 unacknowledged events by
default. Configure the timing and queue bound with `flushIntervalMs` and
`maxQueueSize`:

```ts
const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
  flushIntervalMs: 1_000,
  maxQueueSize: 100_000,
});
```

If enqueueing would exceed the configured queue limit, `capture` throws a
`TrafficWarValidationError` and enqueues none of that call.

The SDK generates a process-monotonic RFC 9562 UUIDv7 `event_id` for each event
that omits one. A caller may override it with any valid UUID. Caller-owned
objects are never modified.

Use `source` for caller-selected origin or runtime metadata such as
`checkout-api`, `node-worker`, or `production`. `span_kind` is separate,
optional tracing semantics (`server`, `client`, `producer`, `consumer`, or
`internal`); it does not replace `source`.

## Flush results and shutdown

Call `flush` when an application needs an acknowledgement before continuing:

```ts
trafficwar.capture({ event: "deployment.finished", source: "release-worker" });

const result = await trafficwar.flush();
console.log(result.accepted);
for (const batch of result.batches) {
  console.log(batch.ingestId, batch.accepted, batch.idempotencyKey);
}
```

`flush` returns an aggregate `FlushResult`: `accepted` is the number of events
drained by that operation, and `batches` contains one `IngestResult` per HTTP
request.

Always await `close` during graceful application shutdown:

```ts
const result = await trafficwar.close();
console.log(result.accepted, result.batches.length);
```

`close` already stops automatic work and flushes every queued event; a separate
shutdown `flush` is unnecessary. The automatic timer is unref'ed and will not
keep Node running, so exiting without awaiting `close` can lose pending events.

`captureBatch(events)` remains as a deprecated compatibility alias. New code
passes the non-empty array directly to `capture(events)`.

## Delivery, retries, and errors

The SDK prepares each HTTP batch once. Its compact JSON bytes, optional gzip
bytes, generated event IDs, and internal idempotency key stay stable across
bounded retries. Idempotency is an internal delivery detail rather than part of
the `capture` API.

Transport failures, per-attempt timeouts, and HTTP 408, 425, 500, 502, 503, and
504 use exponential full jitter. `Retry-After` is honored as a minimum delay
up to 60 seconds; larger values are surfaced immediately as API errors. HTTP
409 and 429 are never retried.

An automatic delivery failure invokes optional `onError`. The handler is
observational: the failed prepared batch remains queued. A later automatic
attempt, `flush`, or `close` retries that same batch, and explicit `flush` or
`close` surfaces an error if delivery still fails.

## Client options

- `apiKey` (required): TrafficWar server API key.
- `baseUrl`: ingest origin. Defaults to `https://ingest.trafficwar.tech`.
- `timeoutMs`: timeout for each attempt. Defaults to 30,000 ms, safely above
  TrafficWar's 10-second durable acknowledgement window.
- `maxRetries`: retries after the first attempt. Defaults to 3.
- `compression`: `"auto"`, `"gzip"`, or `"none"`. Defaults to `"auto"`.
- `compressionThresholdBytes`: gzip threshold in auto mode. Defaults to 1024.
- `flushIntervalMs`: delay from the first pending event to automatic flush.
  Defaults to 1,000 ms.
- `maxQueueSize`: maximum unacknowledged events. Defaults to 100,000.
- `onError`: optional callback for automatic background delivery errors.
- `fetch`: injected Fetch-compatible function, primarily for testing.

The SDK sends `Content-Type: application/json`, `Authorization: Bearer ...`, a
server SDK User-Agent, and `x-trafficwar-sdk`. It never sends `Origin`.

Decoded JSON is limited to 8 MiB. The identity or gzip wire body is limited to
2 MiB. Auto mode gzip-compresses bodies at or above the configured threshold.

```ts
import {
  TrafficWarApiError,
  TrafficWarConnectionError,
  TrafficWarProtocolError,
  TrafficWarRateLimitError,
  TrafficWarValidationError,
} from "@trafficwar/node";

trafficwar.capture({ event: "task.failed", status_code: 500 });

try {
  await trafficwar.flush();
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

Delivery errors retain the batch's internal idempotency key. HTTP and protocol
errors also retain the status, parsed response details, `Retry-After` as
`retryAfterSeconds`, and the ingest ID when supplied by TrafficWar. Rate-limit
errors additionally map `period`, `used`, `limit`, `remainingEvents`,
`batchEvents`, and `retryAfterSecs`.

CommonJS is also supported:

```js
const { TrafficWar } = require("@trafficwar/node");
```

## License

MIT
