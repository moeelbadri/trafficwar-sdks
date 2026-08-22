# TrafficWar Python SDK

Official, typed Python server SDK for durable event ingestion into
[TrafficWar](https://trafficwar.tech).

> **Unreleased breaking change:** this README describes the automatic batching
> API planned after 1.0.0. No package version containing this change has been
> published yet.

## Install

```bash
pip install trafficwar
```

Python 3.9 or newer and HTTPX `>=0.28.1,<1` are supported.

## Synchronous client

```python
from trafficwar import Event, TrafficWar

trafficwar = TrafficWar("tw_live_...")
try:
    event: Event = {
        "event": "checkout",
        "latency_ms": 184.7,
        "status_code": 200,
        "source": "checkout-api",
        "distinct_id": "visitor-42",
        "properties": {"cart_items": 3, "currency": "EUR"},
    }
    trafficwar.capture(event)
    trafficwar.capture(
        [
            {"event": "job.started", "source": "worker"},
            {"event": "job.finished", "source": "worker", "latency_ms": 42},
        ]
    )
finally:
    flushed = trafficwar.close()

print(flushed.accepted, len(flushed.batches))
```

Synchronous `capture` accepts one mapping or a non-empty iterable of mappings.
It validates, snapshots, and enqueues the input, then returns `None` without
waiting for the network. Reuse one thread-safe client across calls. It is also
a context manager; leaving the context calls `close()`.

## Asynchronous client

```python
from trafficwar import AsyncTrafficWar

trafficwar = AsyncTrafficWar("tw_live_...")
try:
    await trafficwar.capture({"event": "page_view", "path": "/pricing", "source": "fastapi"})
    await trafficwar.capture(
        [
            {"event": "signup.started", "source": "fastapi"},
            {"event": "signup.finished", "source": "fastapi", "latency_ms": 92},
        ]
    )
finally:
    flushed = await trafficwar.aclose()

print(flushed.accepted, len(flushed.batches))
```

Async `await capture(...)` accepts the same single-event or non-empty iterable
input and waits only for validation and enqueueing. It does not wait for an
HTTP request or return an `IngestResult`. `AsyncTrafficWar` can also be used as
an async context manager.

## Automatic batching

The first queued event starts a one-second timer. A client flushes when that
timer expires or as soon as 10,000 events are pending. TrafficWar's fixed
server batch maximum is 10,000, so a larger queued iterable is split across
requests.

Every request is a bare JSON array sent to `/v1/server/batch`, including a
single-event capture. The queue holds at most 100,000 unacknowledged events by
default. Configure the timing and bound with `flush_interval` and
`max_queue_size`:

```python
client = TrafficWar(
    "tw_live_...",
    flush_interval=1.0,
    max_queue_size=100_000,
)
```

If enqueueing would exceed the configured queue limit, `capture` raises
`ValidationError` and enqueues none of that call. Iterables are eagerly
consumed so callers can safely reuse or mutate their original objects after
`capture` returns.

## Event fields

`event` is the only required field. `Event` is a `TypedDict` with these
optional fields:

- `event_id`
- `timestamp` (RFC3339 string, epoch milliseconds, or timezone-aware
  `datetime`; datetimes are normalized to UTC RFC3339)
- `latency_ms`
- `properties` (JSON)
- `user_agent`, `label`, `ip`, `source`, `country`, `city`
- `trace_id`, `distinct_id`, `path`
- `error`, `exception`, `error_code`
- `span_kind` (`server`, `client`, `producer`, `consumer`, or `internal`)
- `operation_type`
- `status_code` (0–65535)

The SDK generates a process-monotonic RFC 9562 UUIDv7 `event_id` for each event
that omits one. A caller may override it with any valid UUID.

Use `source` for caller-selected origin or runtime metadata such as
`checkout-api`, `django`, or `worker`. `span_kind` is separate, optional
trace-specific role metadata; it does not replace `source`.

Caller-owned mappings are never modified. JSON is serialized once in compact,
deterministic UTF-8 form. Automatic gzip starts at 1 KiB; configure
`compression="gzip"` or `compression="none"` to force either mode:

```python
client = TrafficWar(
    "tw_live_...",
    timeout=30,
    max_retries=3,
    compression="auto",
    compression_threshold=1024,
    flush_interval=1.0,
    max_queue_size=100_000,
    on_error=lambda error: print(f"automatic TrafficWar flush failed: {error}"),
)
```

The decoded JSON limit is 8 MiB and the transmitted-body limit is 2 MiB.

## Flush results and shutdown

Call `flush()` when an application needs an acknowledgement before continuing:

```python
client.capture({"event": "deployment.finished", "source": "release-worker"})
result = client.flush()

print(result.accepted)
for batch in result.batches:
    print(batch.ingest_id, batch.accepted, batch.idempotency_key)
```

`flush()` and `await flush()` return an aggregate `FlushResult`: `accepted` is
the number of events drained by that operation, and `batches` contains one
`IngestResult` per HTTP request.

Always call synchronous `close()` or await async `aclose()` during graceful
application shutdown. Close already stops automatic work and flushes every
queued event, so a separate shutdown flush is unnecessary. The synchronous
worker is a daemon thread, and the async client owns a background task; exiting
without closing can lose pending events or leak task/resource warnings.

`capture_batch(events)` remains as a deprecated compatibility alias. New code
passes the non-empty iterable directly to `capture(events)`.

## Retries and errors

The SDK prepares each HTTP batch once. Its compact JSON bytes, optional gzip
bytes, generated event IDs, and internal idempotency key stay stable across
bounded retries. Idempotency is an internal delivery detail rather than part of
the `capture` API.

The SDK retries transport and timeout failures plus HTTP 408, 425, 500, 502,
503, and 504 responses with exponential jitter and `Retry-After` support. The
default is three retries after the initial attempt. A retryable response asking
for more than 60 seconds is surfaced immediately as `ServerError`. HTTP 409 and
quota HTTP 429 responses are never retried.

An automatic delivery failure invokes optional `on_error`. The callback is
observational: the failed prepared batch remains queued. A later automatic
attempt, `flush`, `close`, or `aclose` retries that same batch, and an explicit
flush or close surfaces an error if delivery still fails.

## Errors

All SDK exceptions derive from `TrafficWarError`:

- `ValidationError` and `SerializationError`
- `TransportError`
- `APIError`, `AuthenticationError`, `ConflictError`, and `ServerError`
- `RateLimitError`
- `ResponseError` for malformed success or error responses

API errors retain the response body's `status`, HTTP `status_code`, parsed
`details`, `retry_after`, `ingest_id`, and `idempotency_key`. `RateLimitError`
also exposes `period`, `used`, `limit`, `remaining_events`, `batch_events`, and
`retry_after_secs`.

```python
from trafficwar import RateLimitError

client.capture({"event": "job.failed", "status_code": 500})

try:
    client.flush()
except RateLimitError as exc:
    print(exc.period, exc.remaining_events, exc.retry_after)
```

## Custom HTTPX clients

Inject a configured HTTPX client for custom transports, proxies, certificates,
or instrumentation. TrafficWar does not close caller-owned clients.

```python
import httpx
from trafficwar import TrafficWar

http = httpx.Client(http2=True)
trafficwar = TrafficWar("tw_live_...", http_client=http)
try:
    trafficwar.capture({"event": "job_finished"})
finally:
    trafficwar.close()  # flushes the event and leaves `http` open
    http.close()
```

The SDK sends a standalone request containing only its own body and headers.
Defaults from an injected client's headers, cookies, query parameters, and
authentication are never merged into TrafficWar requests.

## License

MIT
