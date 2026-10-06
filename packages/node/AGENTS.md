# Applying @trafficwar/node correctly

Read this guide before instrumenting an application. `README.md` contains the
full API and tier-placement rules. This is a server SDK for Node 22+;
framework hooks and dependency instrumentation must be implemented by the
application. Installing the package alone does not capture requests.

## Lifecycle and delivery

- Create one long-lived `TrafficWar` client per service/API key, not per
  request. Load the key from a server-side environment variable. Never send
  it to a browser or commit it.
- `strictCatalog` defaults to true. Deploy application source and set
  `catalogRoot` to include instrumentation and its relative imports. Check
  `captureEnabled` after construction; startup issues disable all sending.
  Do not silently opt out to hide scanner issues. Use `strictCatalog: false`
  only when the application intentionally accepts unrestricted identities
  or cannot deploy scannable source.
- `capture(event)` and `capture([events])` validate, snapshot, and enqueue
  synchronously and return `void`. They do not acknowledge durable delivery.
- A clean startup scan uploads fixed declarations to `/v1/server/catalog`
  independently of events; `close()` waits for that registration too. The panel
  preloads stations and event/label choices from this service-scoped catalog.
  Keep station `source`, `span_kind`, and `operation_type` statically resolvable
  to preload them. Unresolved metadata registers the pair with
  `station_known: false` and waits for live traffic to identify its station.
  No source paths, payloads, latency, clients, or lanes are registered. Catalog
  writes merge idempotently; removed declarations are not automatically deleted.
  Registration failures use `onError` without blocking event capture. Both
  `strictCatalog: false` and `verbose: false` disable scanning/registration.
- The scan includes all recognized TrafficWar calls under `catalogRoot`, not
  only one client instance's calls. Use separate per-service source roots when
  an application contains clients for different service keys.
- Automatic batching starts after one second or at 10,000 pending events;
  the default queue bound is 100,000 unacknowledged events. Validation and
  queue overflow can throw; do not let instrumentation replace an
  application's response or hide its original error.
- Supply `onError` to observe background delivery failures. Await `close()`
  at graceful shutdown or the end of a short-lived job; do not close or flush
  the shared client on every request. Do not exit before shutdown finishes.
- Omit `event_id` to use the generated UUIDv7. Do not reuse IDs across
  distinct events. Spans share `trace_id`, not `event_id`.

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

## Startup inventory is best-effort diagnostics

- `verbose: true` prints a source inventory at client construction;
  `debug: true` separately prints batch lifecycle logs. Both default to off.
- The AST inventory resolves literals, unchanged constant bindings, shorthand
  fields, shared objects/arrays, static spreads/computed keys, string enums,
  TypeScript assertions, and concatenations/templates with fixed inputs.
  Relative ESM imports and reexports within the scan root are resolved too.
- Calls must belong to TrafficWar: import/require `@trafficwar/node`, construct
  the client, or annotate an injected client/parameter with its imported
  `TrafficWar` type. A variable named `client` alone is not evidence. Prefer
  direct SDK calls with explicit stable identities inside framework hooks;
  do not hide identity selection behind opaque wrappers.
- Optional/bracket calls, simple `.bind(client)` aliases, `captureBatch`,
  `.call`/`.apply`, and calls inside template expressions are recognized.
  The scanner never runs application code to determine values.
- Runtime values, opaque function results, parameter-derived identities,
  TypeScript path aliases, dynamic imports, and CommonJS local export graphs
  are not generally resolved. Mutated objects or objects passed to unknown
  code are treated conservatively; unknown spreads/keys can override literals.
- Set `catalogRoot` to the application source directory. The scan defaults
  to `process.cwd()`, runs synchronously per client, and skips dependencies,
  build output (`dist`, `build`, `.next`, etc.), declarations, `test`/`tests`/
  `__tests__`, and `*.test.*`/`*.spec.*`. Symlinks are skipped and mark the
  scan incomplete. Limits: 4,000 files, depth 12, 512 KiB/file, 16 MiB total
  source, 128 resolution levels, and 100,000 value evaluations.
- Other libraries' `capture` APIs and branches proven unreachable are ignored.
  Conditions requiring runtime information and unused function bodies remain
  scanned. This is bounded binding analysis, not a full TypeScript checker or
  whole-program proof; an empty catalog does not prove missing instrumentation.
- No standalone CLI, framework route enumeration, or Python equivalent is
  provided. Do not claim the startup list is an exhaustive event catalog or
  proof that any listed event has been sent.

## Default protection: strictCatalog

- `strictCatalog: true` is the default and requires fixed event/label
  identities with source available at `catalogRoot`. It works independently
  of `verbose`; verbose and debug output remain disabled by default.
- Explicit `strictCatalog: false` disables the startup gate and runtime
  allowlist. With verbose also off, no source scan runs. This opt-out preserves
  the previous unrestricted capture behavior; it is not a warning-only guard.
- Any missing/unresolved fields, failed or incomplete scan, or empty catalog
  sets `captureEnabled` to false. Startup prints file/line issues with
  `console.error`; subsequent capture calls enqueue nothing and the client
  sends nothing. Fix the issues and recreate the client to enable capture.
- Unresolved does not mean proven dynamic. Use literals or statically
  resolvable constants for event/label fields. Keep all required relative
  imports inside `catalogRoot`; parse failures or missing local imports also
  disable capture. Tests in nonstandard locations can still be scanned.
- Put runtime-dependent object spreads before explicit `event` and `label`
  fields so those identities cannot be overridden by an unresolved spread.
- A clean catalog becomes a runtime pair allowlist. An unlisted event/label
  throws `TrafficWarValidationError`, rejecting the entire capture call.
  Previously queued valid events are still delivered. Catch instrumentation
  errors where needed to preserve application responses.
- Do not restrict dynamic timestamps, measured durations, IDs, or properties.
  This guard bounds event/label values; it cannot prove source provenance for
  a computed runtime value that happens to equal a permitted pair.
