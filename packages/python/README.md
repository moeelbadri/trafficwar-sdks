# TrafficWar Python SDK

Official, typed Python server SDK for durable event ingestion into
[TrafficWar](https://trafficwar.tech).

## Install

```bash
pip install trafficwar
```

Python 3.9 or newer and HTTPX `>=0.28.1,<1` are supported.

## Synchronous client

```python
from trafficwar import Event, TrafficWar

event: Event = {
    "event": "checkout",
    "latency_ms": 184.7,
    "status_code": 200,
    "distinct_id": "visitor-42",
    "properties": {"cart_items": 3, "currency": "EUR"},
}

with TrafficWar("tw_live_...") as trafficwar:
    result = trafficwar.capture(event)

print(result.accepted, result.ingest_id)
```

Reuse one client across calls. It owns a connection pool and is safe to use as
a context manager.

## Asynchronous client

```python
from trafficwar import AsyncTrafficWar

async with AsyncTrafficWar("tw_live_...") as trafficwar:
    result = await trafficwar.capture_batch(
        [
            {"event": "page_view", "path": "/pricing"},
            {"event": "signup", "latency_ms": 92},
        ]
    )
```

A batch must contain 1–10,000 events. The SDK sends the server API's required
bare JSON array rather than wrapping it in an object.

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

The service derives the account and service from the API key. Do not put
`user_id` or `service` in an event. The SDK does not generate `event_id`.

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
)
```

The decoded JSON limit is 8 MiB and the transmitted-body limit is 2 MiB.

## Retries and idempotency

Every SDK call gets a fresh `Idempotency-Key`. The SDK retries transport and
timeout failures plus HTTP 408, 425, 500, 502, 503, and 504 responses. A retry
uses the exact same serialized/compressed bytes and key, with exponential
jitter and `Retry-After` support. The default is three retries after the
initial attempt. To keep calls bounded, a retryable response that asks for
more than 60 seconds is surfaced immediately as `ServerError` instead of
sleeping.

Supply your own key when coordinating retries outside the SDK:

```python
result = client.capture(
    {"event": "order_paid", "event_id": "evt_123"},
    idempotency_key="order-123-paid-v1",
)
```

Keys must be 1–256 visible ASCII characters. They are scoped to the service,
body-sensitive, and path-sensitive, and are retained by TrafficWar for about
five minutes. Reusing a key for a different request raises `ConflictError`.
HTTP 409 and quota HTTP 429 responses are never retried.

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

try:
    client.capture_batch(events)
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
    trafficwar.close()  # leaves `http` open
    http.close()
```

The SDK sends a standalone request containing only its own body and headers.
Defaults from an injected client's headers, cookies, query parameters, and
authentication are never merged into TrafficWar requests.

## License

MIT
