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
        "event": "http",
        "http_method": "POST",
        "label": "Checkout",
        "path": "/v1/checkout",
        "source": "backend-a",
        "span_kind": "server",
        "operation_type": "route.handler",
        "status_code": 200,
        "latency_ms": 184.2,
        "distinct_id": "usr_7f3a91c2",
        "properties": {
            "device_id": "dev_0198e743-a2c4-7c21",
        },
    }
    trafficwar.capture(event)
finally:
    flushed = trafficwar.close()

print(flushed.accepted, len(flushed.batches))
```

Synchronous `capture` accepts one mapping or a non-empty iterable of mappings.
It validates, snapshots, and enqueues the input, then returns `None` without
waiting for the network. Reuse one thread-safe client across calls. It is also
a context manager; leaving the context calls `close()`.

## Asynchronous client

The array form sends one complete trace. Emit dependency spans first and the
edge span last, and set `timestamp` on every span; see
[Traces and tiers](#traces-and-tiers).

```python
import uuid
from datetime import datetime, timedelta, timezone

from trafficwar import AsyncTrafficWar

trafficwar = AsyncTrafficWar("tw_live_...")
started_at = datetime.now(timezone.utc)
trace_id = str(uuid.uuid4())


def at(offset_ms: float) -> datetime:
    return started_at + timedelta(milliseconds=offset_ms)


common = {
    "label": "Pricing",
    "path": "/pricing",
    "distinct_id": "usr_7f3a91c2",
    "trace_id": trace_id,
}

try:
    await trafficwar.capture(
        [
            {
                **common,
                "event": "database",
                "source": "db-replica-1",
                "operation_type": "postgres.select",
                "span_kind": "client",
                "timestamp": at(12),
                "latency_ms": 6.1,
            },
            {
                **common,
                "event": "redis",
                "source": "redis-1",
                "operation_type": "redis.get",
                "span_kind": "client",
                "timestamp": at(20),
                "latency_ms": 1.4,
            },
            {
                **common,
                "event": "s3",
                "source": "assets.ovh-s3",
                "operation_type": "s3.get_object",
                "span_kind": "client",
                "timestamp": at(25),
                "latency_ms": 22.0,
            },
            {
                **common,
                "event": "external",
                "source": "search-provider",
                "operation_type": "search.query",
                "span_kind": "client",
                "timestamp": at(48),
                "latency_ms": 12.0,
            },
            {
                **common,
                "event": "http",
                "http_method": "GET",
                "status_code": 200,
                "source": "backend-a",
                "operation_type": "route.handler",
                "span_kind": "server",
                "timestamp": at(5),
                "latency_ms": 68.0,
            },
            {
                **common,
                "event": "http",
                "http_method": "GET",
                "status_code": 200,
                "source": "https://app.example.com",
                "operation_type": "http.request",
                "span_kind": "client",
                "timestamp": at(0),
                "latency_ms": 82.4,
            },
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
  `datetime`; datetimes are normalized to UTC RFC3339; defaults to capture time
  when omitted)
- `latency_ms`
- `properties` (JSON)
- `user_agent`, `label`, `ip`, `source`, `country`, `city`
- `trace_id`, `distinct_id`, `path`
- `http_method` (trimmed and normalized to uppercase; must be a
  1–64-character RFC HTTP token)
- `error`, `exception`, `error_code`
- `span_kind` (`server`, `client`, `producer`, `consumer`, or `internal`)
- `operation_type`
- `status_code` (0–65535)

The SDK generates a process-monotonic RFC 9562 UUIDv7 `event_id` for each event
that omits one. A caller may override it with any valid UUID.

Canonical `event` categories are `http`, `database`, `redis`, `s3`, and
`external`. Use `external` for an outbound HTTP service that belongs on the
infrastructure tier. Use `source` for the emitting host or dependency
(`backend-a`, `db-primary`, `redis-1`, `ovh-s3`, `google-routes`), `label` for
the human route name (`Checkout`), `path` for the route URL
(`/v1/checkout`), and `operation_type` for the concrete work
(`route.handler`, `postgres.select`, `redis.get`, `s3.get_object`,
`google.routes.compute`). Spans of one request share `trace_id`. `span_kind`
does not replace `source`, and it is not decorative: `event`, `source`, and
`span_kind` are the three fields that place a span on a tier.

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
from `event` and `source`, so `db-replica-1`, `redis-1`, `assets.ovh-s3`, and
`search-provider` each get their own station.

Keep inclusive durations nested: the sum of the dependency spans must not
exceed the server span, which must not exceed the client span. Set `timestamp`
on every span of a trace. A server normally captures all of its spans after the
request has finished, and the default capture-time timestamp would collapse
them onto one instant, leaving the waterfall with no chronological axis. A
single-span request needs none of this: one `http` span with
`span_kind="server"` is a complete, valid event.

A server cannot measure a browser's round trip. If you emit the edge span from
your backend, make it the widest interval you actually measured — the full
server-side hop including routing and middleware — and let the server span
cover only the handler. Do not invent a client round trip, and do not drop
`latency_ms` to sidestep the problem: an absent value is stored as `0` and
enters the latency histogram. If you have nothing wider than the handler to
report, send the server span alone.

Two cautions. `source` is part of the metric aggregation grain, so when you
derive it from `Origin` or `Referer`, match those caller-controlled values
against an allowlist of hostnames you expect and collapse the rest to a single
value such as `web-other`.

For an outbound third-party HTTP call, send `event="external"` with
`span_kind="client"`. Keep the provider in `source` and the API action in
`operation_type`; this creates a source-keyed infrastructure station. The
incoming caller remains an `http` client span. If a request has no trusted
`Origin` or `Referer`, use a stable value such as `web-direct`; never substitute
your own API `Host` header.

## Actor identity and application errors

Use a stable pseudonymous `distinct_id` derived by your backend so one actor
keeps the same identity across devices. Prefer an opaque internal ID or a
backend-only HMAC; do not send a raw email address. Keep a separate
installation identifier such as `device_id` in `properties` when device-level
investigation matters.

Send application failures with first-class outcome fields and keep the full
stack trace in `properties`:

```python
import traceback

try:
    submit_order()
except Exception as exc:
    client.capture(
        {
            "event": "http",
            "label": "/checkout",
            "http_method": "POST",
            "status_code": 500,
            "error": str(exc),
            "error_code": type(exc).__name__,
            "distinct_id": "usr_7f3a91c2",
            "properties": {
                "exception_type": type(exc).__name__,
                "stack_trace": "".join(
                    traceback.format_exception(type(exc), exc, exc.__traceback__)
                ),
                "cause": str(exc.__cause__) if exc.__cause__ else "",
            },
        }
    )
```

`properties` is opaque and does not set `is_error`. Always send `error`,
`error_code`, or a `status_code` of 400 or greater with diagnostic properties.

For S3, a provider alias such as `ovh-s3`, `aws-s3`, or `minio` creates one
provider station. Prefix it as `<bucket>.<provider>` only when the map should
separate buckets: `assets.ovh-s3` and `archive.ovh-s3` become distinct
stations, while `operation_type` values such as `s3.get_object` and
`s3.put_object` remain operation dots. The final dot is the reserved
bucket/provider separator, so provider aliases must not contain dots.

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

## Shutdown

Always call synchronous `close()` or await async `aclose()` during graceful
application shutdown:

```python
result = client.close()
print(result.accepted, len(result.batches))
```

Close stops automatic work and sends every queued event. It returns an
aggregate `FlushResult`: `accepted` is the number of events drained, and
`batches` contains one `IngestResult` per HTTP request. The synchronous worker
is a daemon thread, and the async client owns a background task; exiting
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
attempt, `close`, or `aclose` retries that same batch, and close surfaces an
error if delivery still fails.

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
    client.close()
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
