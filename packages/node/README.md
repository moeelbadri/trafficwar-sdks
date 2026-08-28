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
  http_method: "POST",
  label: "Checkout",
  path: "/v1/checkout",
  source: "backend-a",
  span_kind: "server",
  operation_type: "route.handler",
  status_code: 200,
  latency_ms: 184.2,
  distinct_id: "usr_7f3a91c2",
  properties: {
    device_id: "dev_0198e743-a2c4-7c21",
  },
});
```

`event`, `source`, and `span_kind` together decide which tier this span appears
on. Read [Traces and tiers](#traces-and-tiers) before sending several spans per
request.

`capture` accepts one event or a non-empty array. It validates, snapshots, and
enqueues the input synchronously, then returns `void`; it does not return an
`IngestResult` or wait for the network.

`Date` timestamps are serialized as RFC3339 without changing the caller's
object. String timestamps must be RFC3339; numeric timestamps are integer epoch
milliseconds. If `timestamp` is omitted, the SDK sets it to the current time at
capture, which is right for a standalone event and wrong for a trace captured
after the request has already finished.

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

Canonical `event` categories are `http`, `database`, `redis`, `s3`, and
`external`. Use `external` for an outbound HTTP service that belongs on the
infrastructure tier. Use
`source` for the emitting host or dependency (`backend-a`, `db-primary`,
`redis-1`, `ovh-s3`, `google-routes`, `https://app.example.com`), `label` for
the human route name (`Checkout`), `path` for the route URL
(`/v1/checkout`), and `operation_type` for the concrete work
(`route.handler`, `postgres.select`, `redis.get`, `s3.get_object`,
`google.routes.compute`). For HTTP events, `http_method` is trimmed and
normalized to uppercase and must be a 1–64-character RFC HTTP token. Spans
of one request share `trace_id`. `span_kind` is one of `server`, `client`,
`producer`, `consumer`, or `internal`, lowercase; any other value is
discarded. It does not replace `source`, and it is not decorative: `event`,
`source`, and `span_kind` are the three fields that place a span on a tier.

## Traces and tiers

Spans of one request share `trace_id` and `label`. There is no `span_id` or
`parent_span_id` on the wire, so TrafficWar places each span on a tier from its
own fields, in this order:

1. `event` is `database`, `redis`, `s3`, or `external` —
   **infrastructure**.
2. `event` is `http` and `source` is an absolute `http(s)://` URL, or starts
   with `web`, `browser`, `client`, `edge`, or `frontend` followed by a
   separator or nothing (`web`, `web-eu`, `frontend.eu`, but not `webhooks`)
   — **edge**.
3. `event` is `http` and `source` contains `api`, `backend`, or `server` as a
   token delimited by `-`, `_`, or `.` — **backend**.
4. `event` is `http` and `span_kind` is `server` — **backend**; `client` —
   **edge**.
5. Anything else — **edge**.

`source` is compared case-insensitively and is tested before `span_kind`, so a
`source` such as `api.example.com` or `backend-a` pins a span to the backend
tier regardless of its `span_kind`. Sending your own API hostname as the
`source` of a browser-facing span is the most common way to get a span on the
wrong tier. `operation_type` never affects tier placement; it names the
concrete activity. Only `server` and `client` select an HTTP tier:
`producer`, `consumer`, and `internal` fall through to rule 5, so an `http`
span with one of those kinds lands on the edge tier.

On the edge and backend tiers the station is named by `label`, and `source`
becomes an instance dot inside that station. Infrastructure stations are named
from `event` and `source`, so `db-primary`, `redis-1`, `receipts.ovh-s3`, and
`google-routes` each get their own station.

### Send a complete trace

Emit dependency spans first and the edge span last, and keep inclusive
durations nested: the sum of the dependency spans must not exceed the server
span, which must not exceed the client span. Set `timestamp` on every span of a
trace. A server normally captures all of its spans after the request has
finished, and the default capture-time timestamp would collapse them onto one
instant, leaving the waterfall with no chronological axis.

```ts
const trace_id = crypto.randomUUID();
const startedAt = Date.now();
const at = (offsetMs: number) => new Date(startedAt + offsetMs);
const label = "Checkout";
const path = "/v1/checkout";
const distinct_id = "usr_7f3a91c2";

trafficwar.capture([
  { event: "database", label, path, distinct_id, trace_id,
    source: "db-primary", operation_type: "postgres.select",
    span_kind: "client", timestamp: at(20), latency_ms: 48.2 },
  { event: "redis", label, path, distinct_id, trace_id,
    source: "redis-1", operation_type: "redis.get",
    span_kind: "client", timestamp: at(70), latency_ms: 1.4 },
  { event: "s3", label, path, distinct_id, trace_id,
    source: "receipts.ovh-s3", operation_type: "s3.put_object",
    span_kind: "client", timestamp: at(75), latency_ms: 22.0 },
  { event: "external", label, path, distinct_id, trace_id,
    source: "payment-gateway", operation_type: "payment.authorize",
    span_kind: "client", timestamp: at(100), latency_ms: 20.0 },
  { event: "http", label, path, distinct_id, trace_id,
    source: "backend-a", operation_type: "route.handler",
    span_kind: "server", timestamp: at(8), latency_ms: 160,
    http_method: "POST", status_code: 200 },
  { event: "http", label, path, distinct_id, trace_id,
    source: "https://app.example.com", operation_type: "http.request",
    span_kind: "client", timestamp: at(0), latency_ms: 184.2,
    http_method: "POST", status_code: 200 },
]);
```

That trace renders as one journey: an edge station for `Checkout` with
`https://app.example.com` as its caller, a backend station for `Checkout`
served by `backend-a`, and four infrastructure stations beneath it.

A single-span request needs none of this. One `http` span with
`span_kind: "server"` is a complete, valid event.

### Edge spans emitted by a server

A server cannot measure a browser's round trip. If you emit the edge span from
your backend, make it the widest interval you actually measured — the full
server-side hop including routing and middleware — and let the server span
cover only the handler. Do not invent a client round trip, and do not drop
`latency_ms` to sidestep the problem: an absent value is stored as `0` and
enters the latency histogram. If you have nothing wider than the handler to
report, send the server span alone. A trace does not require an edge span.

### Two cautions

`source` is part of the metric aggregation grain. When you derive it from
`Origin` or `Referer`, those are caller-controlled values: match them against
an allowlist of hostnames you expect and collapse the rest to a single value
such as `web-other`, rather than forwarding arbitrary header content.

For an outbound third-party HTTP call, send `event: "external"` with
`span_kind: "client"`. Keep the provider in `source` and the API action in
`operation_type`:

```ts
trafficwar.capture({
  event: "external",
  source: "google-routes",
  label: "Route planner",
  span_kind: "client",
  operation_type: "google.routes.compute",
  latency_ms: 13,
});
```

This creates a source-keyed infrastructure station. The incoming caller remains
an `http` client span. If a request has no trusted `Origin` or `Referer`, use a
stable value such as `web-direct`; never substitute your own API `Host` header.

## Actor identity and application errors

Use a stable pseudonymous `distinct_id` derived by your backend so one actor
keeps the same identity across devices. Prefer an opaque internal ID or a
backend-only HMAC; do not send a raw email address. Keep a separate
installation identifier such as `device_id` in `properties` when device-level
investigation matters.

Send application failures with first-class outcome fields and keep the full
stack trace in `properties`:

```ts
try {
  await submitOrder();
} catch (caught) {
  const error = caught instanceof Error ? caught : new Error(String(caught));

  trafficwar.capture({
    event: "http",
    label: "Checkout",
    path: "/v1/checkout",
    source: "backend-a",
    span_kind: "server",
    http_method: "POST",
    status_code: 500,
    error: error.message,
    error_code: "CHECKOUT_FAILED",
    distinct_id: "usr_7f3a91c2",
    properties: {
      exception_type: error.name,
      stack_trace: error.stack ?? error.message,
      cause: "connection deadline exceeded",
    },
  });
}
```

`properties` is opaque and does not set `is_error`. Always send `error`,
`error_code`, or a `status_code` of 400 or greater with diagnostic properties.

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

trafficwar.capture({ event: "http", label: "Checkout", status_code: 500 });

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
