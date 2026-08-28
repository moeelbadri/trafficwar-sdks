# Changelog

All notable changes to the TrafficWar server SDKs are documented here.

## Unreleased

## 2.2.3 (Node.js) / Unreleased (Python) - 2026-08-28

- Add `external` to the canonical `EventCategory` suggestions for outbound
  HTTP services that belong on TrafficWar's infrastructure tier.
- Document source-keyed external-service stations and update the trace examples
  to distinguish incoming HTTP client spans from outbound dependencies.
- Replace the 2.2.2 warning that third-party HTTP must render on the edge tier;
  no new wire field is required and existing event payloads remain compatible.

## 2.2.2 (Node.js) / Unreleased (Python) - 2026-08-27

- Document the tier placement rule. `event`, `source`, and `span_kind` decide
  whether a span renders on the edge, backend, or infrastructure tier, `source`
  is evaluated before `span_kind`, and `operation_type` never affects
  placement. Previously this was only discoverable by experiment.
- Rewrite the trace examples so they produce usable tier data: every span
  carries `span_kind` and an explicit `timestamp`, dependencies are emitted
  first and the edge span last, and the nesting contract is stated.
- Warn that the capture-time `timestamp` default collapses a trace recorded
  after its request onto one instant.
- Document how a server-emitted edge span should be measured, why `latency_ms`
  must not be omitted to avoid inventing one, that `source` derived from
  `Origin` or `Referer` belongs on an allowlist, and that outbound third-party
  HTTP has no dependency category today.
- Replace the non-canonical `task.failed` example event and stop using a URL
  as a `label`.

## 2.2.1 (Node.js) / Unreleased (Python) - 2026-08-27

- Add editor-friendly open event and operation types plus a documented
  `S3Source` convention.
- Define S3 `source` as a provider alias, optionally qualified as
  `<bucket>.<provider>` when separate bucket stations are useful. Keep
  `operation_type` as the operation-dot identity.
- Update Node.js, Python, and trace examples to use provider-aware S3 sources.
- Document pseudonymous `distinct_id`, optional `device_id` in `properties`,
  and application error capture with stack traces in `properties`.

## 2.2.0 (Node.js) / Unreleased (Python) - 2026-08-23

- Add typed optional `http_method` event support to Node.js and Python. Values
  are trimmed, normalized to uppercase, and validated as 1–64-character RFC
  HTTP tokens.
- Align capture examples with the canonical `http`, `database`, `redis`, and
  `s3` event categories while preserving `source`, `label`, `path`, and
  `operation_type` semantics.
- Document shutdown with `close` only; stop telling callers to invoke `flush`.

## 2.1.1 (Node.js) - 2026-08-22

- Default missing event `timestamp` to capture time in the Node.js and Python
  SDKs.

## 2.1.0 (Node.js) - 2026-08-22

- Add opt-in safe batch lifecycle logging with `debug: true`.
- Document npm, pnpm, and Bun installation commands for `@trafficwar/node`.
- Remove the 2.0.0 breaking-change banner from the Node.js README install
  section.

## 2.0.0 (Node.js) / Unreleased (Python) - 2026-08-22

Published for npm as `@trafficwar/node` 2.0.0. The equivalent Python package
update remains unreleased.

- **Breaking:** make `capture` the automatic-batching API for one event or a
  non-empty array/iterable. It now enqueues without waiting for delivery and
  no longer returns an `IngestResult`; async Python waits only for enqueueing.
- Flush one second after the first queued event or at the fixed 10,000-event
  server batch maximum. Add a configurable queue limit that defaults to
  100,000 unacknowledged events.
- Send every prepared batch as a bare array to `/v1/server/batch`, retain failed
  deliveries for later attempts, and return aggregate `FlushResult` values
  from explicit flush and close operations.
- Generate process-monotonic RFC 9562 UUIDv7 event IDs unless callers provide
  any valid UUID, while preserving stable internal idempotency for each HTTP
  batch and its retries.
- Add optional background-delivery error callbacks and require applications to
  close clients during graceful shutdown so queued events are not abandoned.
- Deprecate `captureBatch` and `capture_batch` as compatibility aliases for
  passing an array or iterable directly to `capture`.
- Clarify that `source` is caller-selected origin/runtime metadata and
  `span_kind` remains separate optional tracing semantics.
- Update all framework examples and integration tests for enqueue-first
  handlers, explicit deterministic test flushes, and close-driven shutdown.

## 1.0.0 - 2026-08-21

- Add the `@trafficwar/node` server SDK.
- Add synchronous and asynchronous `trafficwar` Python clients.
- Add durable request acknowledgement, automatic request idempotency, bounded
  retries, gzip compression, typed event fields, and batch ingestion.
