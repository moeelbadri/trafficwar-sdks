# Applying @trafficwar/node correctly

Read this guide before instrumenting an application. `README.md` contains the
full API and tier-placement rules. This is a server SDK for Node 22+;
framework hooks and dependency instrumentation must be implemented by the
application. Installing the package alone does not capture requests.

## Lifecycle and delivery

- Create one long-lived `TrafficWar` client per service/API key, not per
  request. Load the key from a server-side environment variable. Never send
  it to a browser or commit it.
- `capture(event)` and `capture([events])` validate, snapshot, and enqueue
  synchronously and return `void`. They do not acknowledge durable delivery.
- Automatic batching starts after one second or at 10,000 pending events;
  the default queue bound is 100,000 unacknowledged events. Validation and
  queue overflow can throw; do not let instrumentation replace an
  application's response or hide its original error.
- Supply `onError` to observe background delivery and catalog failures. Await
  `close()` at graceful shutdown or the end of a short-lived job; do not close
  or flush the shared client on every request. Do not exit before shutdown finishes.
- Omit `event_id` to use the generated UUIDv7. Do not reuse IDs across
  distinct events. Spans share `trace_id`, not `event_id`.

## Automatic observed pairs

- Accepted captures automatically discover exact event/label pairs. Captured
  values are never rewritten or pinned to a code location. A shared wrapper
  can send different categories and labels on every call, as can batch slots.
- Only an entire call that passes event validation, duplicate-ID checks and
  queue capacity teaches pairs. Missing labels and strings unsuitable for the
  catalog do not block otherwise valid event delivery. Event validation is
  unchanged: supplied non-string labels are still invalid event fields.
- Register only non-blank event/label strings, at most 128 Unicode code points
  each, with no control characters. Preserve case and whitespace exactly;
  identity is the pair, not a concatenation of its values or their cross product.
- One in-memory sent/pending list belongs to each client. New pairs coalesce
  for a fixed 1-second window, not a resetting debounce. Uploads serialize,
  send unsent deltas only and mark sent only after a successful response.
  Repeated captures and concurrent flush calls do not create duplicate uploads.
- Bearer-authenticated `POST /v1/server/catalog` sends only
  `{ captures: [{ event, label, station_known: false }] }`. The backend adds
  and deduplicates rather than replacing the service list. Actual events supply
  station metadata; declarations do not create traffic, clients, latency or lanes.
- No AST/source scanning, explicit declarations, strict/static switches,
  captureEnabled getter, location pinning, filesystem access, JSON persistence,
  API polling, startup registration or wrapper-first-value rewriting exists.
  Do not invent fake captures to register pairs. Python does not register pairs.
- Registration reuses bounded transport retries/timeouts. Failures report
  safely through `onError` and retain pending pairs. Automatic retry cycles
  use exponential cooldowns from 1 s up to 30 s; captures and flush calls cannot
  bypass a cooldown. Without `onError`, a generic error is printed.
- `flush()` awaits current catalog uploads and sends eligible pending pairs,
  bypassing the initial coalescing window but not a failure cooldown. `close()`
  does the same, then stops catalog timers. Catalog failures never reject event
  delivery; counts returned by flush/close are event-only. Failed pending pairs
  can be lost on close or abrupt process exit; there is no durable catalog log.
- Sent pairs remain remembered for the lifetime of that client. Deleting one
  on the server does not clear SDK memory; after SDK restart it can reappear
  when observed again. Independent clients/replicas may upload the same pair;
  the additive server deduplicates them. No complete-list coordination is needed.
- Use stable low-cardinality names: client memory grows with distinct observed
  pairs. Uploads are chunked to 4,000 pairs, but the backend's service capacity
  still applies; permanent errors remain pending on cooldown until close.
- `debug` keeps safe delivery diagnostics. `verbose` logs only successfully
  registered new pairs, not source inventory or every capture. Both default off.

## Stable event identity

- `event` is the category: `http`, `database`, `redis`, `s3`, or `external`.
  `operation_type` names the work: `route.handler`, `postgres.select`,
  `redis.get`, `s3.get_object`, or `payment.authorize`.
- `label` is a stable human operation name or route template, such as
  `Checkout` or `GET /users/:id`. Never interpolate a user ID, query string,
  timestamp, or request-specific value. String typing does not enforce this.
- `source` is a stable emitter/dependency alias: `backend-a`, `db-primary`,
  `redis-1`, `assets.ovh-s3`, or `payment-gateway`. It is not the ingest host
  or a request-specific URL. Allowlist caller-controlled hostnames before
  using them as sources.
- `path` carries the route path. Prefer templates for parameterized routes;
  avoid secrets and query strings. HTTP spans also carry `http_method` and
  `status_code`.
- Put a pseudonymous actor identifier in `distinct_id`, a device identifier
  in `properties`, and request correlation in `trace_id`. Do not use a raw
  email address as the actor identifier.

```ts
import { TrafficWar } from "@trafficwar/node";

const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
  onError: (error) => console.error("TrafficWar delivery failed", error),
});

// After handling the request: use its measured start time and duration.
trafficwar.capture({
  event: "http",
  label: "Checkout",
  source: "backend-a",
  operation_type: "route.handler",
  span_kind: "server",
  path: "/v1/checkout",
  http_method: "POST",
  status_code: responseStatus,
  timestamp: requestStartedAt,
  latency_ms: measuredDurationMs,
});
```

## Traces and errors

- Spans for one request share `trace_id` and `label`. Measure durations with
  a monotonic clock; `timestamp` is the actual span start as a `Date`, RFC3339
  string, or integer epoch milliseconds. If captured after completion,
  default capture-time timestamps do not describe the span's start.
- Keep inclusive durations nested. Emit dependency spans first, then the
  server span, then an edge span if one was actually measured. Do not invent
  browser latency or emit a synthetic edge span solely to populate the map.
- Incoming handlers use `event: "http"`, `span_kind: "server"`, and a backend
  source. Outbound HTTP dependencies use `event: "external"`,
  `span_kind: "client"`, and a stable dependency source. Database, Redis, and
  S3 spans use their own categories and dependency sources.
- `event`, `source`, and `span_kind` determine tier placement; `source` can
  take precedence over `span_kind`. Read the README's tier rules before
  choosing a source. `operation_type` does not choose a tier.
- Errors require `status_code >= 400`, non-empty `error`, or non-empty
  `error_code`. Put stack traces in `properties`. Properties alone do not
  mark an event as an error; redact secrets before capture.
