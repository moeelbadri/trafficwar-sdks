# Changelog

All notable changes to the TrafficWar server SDKs are documented here.

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
