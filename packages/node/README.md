# @trafficwar/node

Official, dependency-free TrafficWar server SDK for Node.js 22 and newer.

## Install

```sh
npm install @trafficwar/node
# or
pnpm add @trafficwar/node
# or
bun add @trafficwar/node
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
  event: "http",
  http_method: "GET",
  label: "Checkout",
  path: "/v1/checkout",
  source: "backend-a",
  operation_type: "route.handler",
  latency_ms: 184.2,
  distinct_id: "u_123",
  trace_id: "tr_1",
});

trafficwar.capture([
  {
    event: "database",
    label: "Checkout",
    path: "/v1/checkout",
    source: "db-primary",
    operation_type: "postgres.select",
    latency_ms: 48.2,
    distinct_id: "u_123",
    trace_id: "tr_1",
  },
  {
    event: "redis",
    label: "Checkout",
    path: "/v1/checkout",
    source: "redis-1",
    operation_type: "redis.get",
    latency_ms: 1.4,
    distinct_id: "u_123",
    trace_id: "tr_1",
  },
  {
    event: "s3",
    label: "Checkout",
    path: "/v1/checkout",
    source: "receipts.ovh-s3",
    operation_type: "s3.put_object",
    latency_ms: 22.0,
    distinct_id: "u_123",
    trace_id: "tr_1",
  },
]);
```

`capture` accepts one event or a non-empty array. It validates, snapshots, and
enqueues the input synchronously, then returns `void`; it does not return an
`IngestResult` or wait for the network.

`Date` timestamps are serialized as RFC3339 without changing the caller's
object. String timestamps must be RFC3339; numeric timestamps are integer epoch
milliseconds. If `timestamp` is omitted, the SDK sets it to the current time at
capture.

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

Set `debug: true` to print queue, flush, request, retry, and acknowledgement
diagnostics with `console.debug`. Debug logging is off by default and never
includes API keys or queued event payloads.

```ts
const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
  debug: true,
});
```

The SDK generates a process-monotonic RFC 9562 UUIDv7 `event_id` for each event
that omits one. A caller may override it with any valid UUID. Caller-owned
objects are never modified.

Canonical `event` categories are `http`, `database`, `redis`, and `s3`. Use
`source` for the emitting host or dependency (`backend-a`, `db-primary`,
`redis-1`, `ovh-s3`, `https://app.example.com`), `label` for the human route
name (`Checkout`), `path` for the route URL (`/v1/checkout`), and
`operation_type` for the concrete work (`route.handler`, `postgres.select`,
`redis.get`, `s3.get_object`). For HTTP events, `http_method` is trimmed and
normalized to uppercase and must be a 1–64-character RFC HTTP token. Spans of
one request share `trace_id`. `span_kind` is separate, optional tracing
semantics (`server`, `client`, `producer`, `consumer`, or `internal`); it does
not replace `source`.

For S3, a provider alias such as `ovh-s3`, `aws-s3`, or `minio` creates one
provider station. Prefix it as `<bucket>.<provider>` only when the map should
separate buckets: `assets.ovh-s3` and `archive.ovh-s3` become distinct
stations, while `operation_type` values such as `s3.get_object` and
`s3.put_object` remain operation dots. The final dot is the reserved
bucket/provider separator, so provider aliases must not contain dots.

The package exports `EventCategory`, `OperationType`, `KnownS3Provider`, and
`S3Source` for typed wrappers. These types suggest the canonical values in
editors while still accepting custom event, operation, and provider aliases:

```ts
import type { S3Source } from "@trafficwar/node";

const assets: S3Source = "assets.ovh-s3";
```

## Shutdown

Always await `close` during graceful application shutdown:

```ts
const result = await trafficwar.close();
console.log(result.accepted, result.batches.length);
```

`close` stops automatic work and sends every queued event. It returns an
aggregate `FlushResult`: `accepted` is the number of events drained, and
`batches` contains one `IngestResult` per HTTP request. The automatic timer is
unref'ed and will not keep Node running, so exiting without awaiting `close`
can lose pending events.

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
attempt or `close` retries that same batch, and `close` surfaces an error if
delivery still fails.

## Client options

- `apiKey` (required): TrafficWar server API key.
- `baseUrl`: ingest origin. Defaults to `https://ingest.trafficwar.tech`.
- `debug`: print safe batch lifecycle diagnostics with `console.debug`.
  Defaults to `false`.
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
  await trafficwar.close();
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
