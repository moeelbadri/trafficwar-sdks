import json
import math
import uuid
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from typing import Any

import httpx
import pytest

from trafficwar import (
    DEFAULT_FLUSH_INTERVAL,
    DEFAULT_MAX_QUEUE_SIZE,
    MAX_BATCH_EVENTS,
    MAX_DECODED_BODY_BYTES,
    MAX_ENCODED_BODY_BYTES,
    AsyncTrafficWar,
    SerializationError,
    TrafficWar,
    ValidationError,
    __version__,
)


def success(request: httpx.Request) -> httpx.Response:
    events = json.loads(request.content)
    return httpx.Response(
        200,
        json={"status": "ok", "accepted": len(events), "ingest_id": "ing_valid"},
    )


def sync_client(**kwargs: Any) -> tuple[TrafficWar, httpx.Client]:
    http = httpx.Client(transport=httpx.MockTransport(success))
    return (
        TrafficWar(
            "key",
            compression="none",
            flush_interval=60,
            http_client=http,
            **kwargs,
        ),
        http,
    )


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"api_key": ""}, "api_key"),
        ({"api_key": " key"}, "api_key"),
        ({"api_key": "kéy"}, "api_key"),
        ({"api_key": "key", "base_url": "ftp://example.test"}, "base_url"),
        ({"api_key": "key", "base_url": "https://"}, "base_url"),
        ({"api_key": "key", "base_url": "https://u:p@example.test"}, "credentials"),
        ({"api_key": "key", "base_url": "https://example.test?q=1"}, "query"),
        ({"api_key": "key", "timeout": 0}, "timeout"),
        ({"api_key": "key", "timeout": float("inf")}, "timeout"),
        ({"api_key": "key", "max_retries": -1}, "max_retries"),
        ({"api_key": "key", "max_retries": True}, "max_retries"),
        ({"api_key": "key", "compression": "br"}, "compression"),
        ({"api_key": "key", "compression_threshold": -1}, "compression_threshold"),
        ({"api_key": "key", "flush_interval": 0}, "flush_interval"),
        ({"api_key": "key", "flush_interval": float("nan")}, "flush_interval"),
        ({"api_key": "key", "max_queue_size": 0}, "max_queue_size"),
        ({"api_key": "key", "max_queue_size": True}, "max_queue_size"),
        ({"api_key": "key", "on_error": "nope"}, "on_error"),
    ],
)
def test_constructor_validates_options(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        TrafficWar(**kwargs)
    with pytest.raises(ValidationError, match=message):
        AsyncTrafficWar(**kwargs)


def test_queue_defaults_and_constants_are_public() -> None:
    http = httpx.Client(transport=httpx.MockTransport(success))
    client = TrafficWar("key", http_client=http)

    assert client.flush_interval == DEFAULT_FLUSH_INTERVAL == 1.0
    assert client.max_queue_size == DEFAULT_MAX_QUEUE_SIZE == 100_000
    assert MAX_BATCH_EVENTS == 10_000
    assert MAX_ENCODED_BODY_BYTES == 2 * 1024 * 1024
    assert MAX_DECODED_BODY_BYTES == 8 * 1024 * 1024

    client.close()
    http.close()


def test_injected_clients_must_match_and_be_open() -> None:
    with pytest.raises(ValidationError, match=r"httpx\.Client"):
        TrafficWar("key", http_client=object())  # type: ignore[arg-type]
    with pytest.raises(ValidationError, match=r"httpx\.AsyncClient"):
        AsyncTrafficWar("key", http_client=object())  # type: ignore[arg-type]

    http = httpx.Client()
    http.close()
    with pytest.raises(ValidationError, match="closed"):
        TrafficWar("key", http_client=http)


@pytest.mark.asyncio
async def test_injected_async_client_must_be_open() -> None:
    http = httpx.AsyncClient()
    await http.aclose()
    with pytest.raises(ValidationError, match="closed"):
        AsyncTrafficWar("key", http_client=http)


@pytest.mark.parametrize(
    "event",
    [
        {},
        {"label": "missing event"},
        {"event": ""},
        {"event": "   "},
        {"event": 123},
        {"event": "x", "unknown": True},
        {"event": "x", "user_id": "forbidden"},
        {"event": "x", "service": "forbidden"},
        {"event": "x", "event_id": None},
        {"event": "x", "span_kind": "database"},
        {"event": "x", "span_kind": []},
    ],
)
def test_event_shape_validation_happens_at_enqueue(event: dict[str, Any]) -> None:
    client, http = sync_client()

    with pytest.raises(ValidationError):
        client.capture(event)  # type: ignore[arg-type]

    assert client.flush().accepted == 0
    client.close()
    http.close()


@pytest.mark.parametrize(
    "value",
    [None, "events", b"events", 42, [], (), iter(())],
)
def test_capture_rejects_invalid_or_empty_iterables(value: Any) -> None:
    client, http = sync_client()

    with pytest.raises(ValidationError):
        client.capture(value)

    client.close()
    http.close()


def test_capture_batch_requires_an_iterable_even_when_mapping_is_valid_event() -> None:
    client, http = sync_client()

    with pytest.deprecated_call(), pytest.raises(ValidationError, match="iterable"):
        client.capture_batch({"event": "not-a-batch"})

    client.close()
    http.close()


@pytest.mark.parametrize("latency", [float("nan"), float("inf"), -float("inf"), True])
def test_latency_must_be_finite_number(latency: Any) -> None:
    client, http = sync_client()
    with pytest.raises(ValidationError, match="latency_ms"):
        client.capture({"event": "x", "latency_ms": latency})  # type: ignore[typeddict-item]
    client.close()
    http.close()


@pytest.mark.parametrize("status_code", [-1, 65_536, 1.5, True])
def test_status_code_must_be_uint16(status_code: Any) -> None:
    client, http = sync_client()
    with pytest.raises(ValidationError, match="status_code"):
        client.capture({"event": "x", "status_code": status_code})  # type: ignore[typeddict-item]
    client.close()
    http.close()


@pytest.mark.parametrize(
    "timestamp",
    [
        "2026-08-21 12:00:00Z",
        "2026-08-21T12:00:00",
        "not-a-date",
        datetime(2026, 8, 21, 12),
        float("nan"),
        True,
    ],
)
def test_timestamp_validation(timestamp: Any) -> None:
    client, http = sync_client()
    with pytest.raises(ValidationError, match="timestamp"):
        client.capture({"event": "x", "timestamp": timestamp})  # type: ignore[typeddict-item]
    client.close()
    http.close()


def test_datetime_is_normalized_and_deeply_snapshotted() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success(request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=60,
        http_client=http,
    )
    timestamp = datetime(
        2026,
        8,
        21,
        14,
        30,
        12,
        123456,
        tzinfo=timezone(timedelta(hours=2)),
    )
    event = {"event": "x", "timestamp": timestamp}

    client.capture(event)  # type: ignore[arg-type]
    client.flush()

    payload = json.loads(requests[0].content)
    assert payload[0]["timestamp"] == "2026-08-21T12:30:12.123456Z"
    assert event["timestamp"] is timestamp
    assert "event_id" not in event
    client.close()
    http.close()


@pytest.mark.parametrize(
    "event_id",
    [
        str(uuid.uuid1()),
        str(uuid.uuid4()),
        "00000000-0000-0000-0000-000000000000",
        str(uuid.uuid4()).upper(),
    ],
)
def test_any_canonical_uuid_override_is_preserved(event_id: str) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success(request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=60,
        http_client=http,
    )
    client.capture({"event": "override", "event_id": event_id})
    client.flush()

    assert json.loads(requests[0].content)[0]["event_id"] == event_id
    client.close()
    http.close()


@pytest.mark.parametrize(
    "event_id",
    [
        "",
        "not-a-uuid",
        "0190b0d0acbd7a2d9bc09a36b7e269fb",
        "{550e8400-e29b-41d4-a716-446655440000}",
    ],
)
def test_invalid_uuid_override_is_rejected(event_id: str) -> None:
    client, http = sync_client()
    with pytest.raises(ValidationError, match="UUID"):
        client.capture({"event": "bad-id", "event_id": event_id})
    client.close()
    http.close()


def test_duplicate_event_ids_in_one_enqueue_are_rejected_atomically() -> None:
    event_id = str(uuid.uuid4())
    client, http = sync_client()

    with pytest.raises(ValidationError, match=r"events\[1\]\.event_id duplicates"):
        client.capture(
            [
                {"event": "one", "event_id": event_id},
                {"event": "two", "event_id": event_id},
            ]
        )

    assert client.flush().accepted == 0
    client.close()
    http.close()


def test_validation_failure_in_iterable_does_not_enqueue_earlier_events() -> None:
    client, http = sync_client()

    with pytest.raises(ValidationError, match=r"events\[1\]\.event"):
        client.capture([{"event": "valid"}, {"event": ""}])

    assert client.flush().accepted == 0
    client.close()
    http.close()


@pytest.mark.parametrize(
    "properties",
    [
        {"invalid": object()},
        {"invalid": float("nan")},
        {"invalid": float("inf")},
        {"invalid": {1, 2, 3}},
    ],
)
def test_nested_json_is_validated_at_enqueue(properties: Any) -> None:
    client, http = sync_client()

    with pytest.raises(SerializationError, match="JSON serializable"):
        client.capture({"event": "x", "properties": properties})  # type: ignore[typeddict-item]

    client.close()
    http.close()


def test_circular_json_is_rejected_at_enqueue() -> None:
    properties: dict[str, Any] = {}
    properties["self"] = properties
    client, http = sync_client()

    with pytest.raises(SerializationError, match="JSON serializable"):
        client.capture({"event": "x", "properties": properties})  # type: ignore[typeddict-item]

    client.close()
    http.close()


def test_queue_overflow_rejects_whole_enqueue() -> None:
    client, http = sync_client(max_queue_size=3)
    client.capture([{"event": "one"}, {"event": "two"}])

    with pytest.raises(ValidationError, match="queue cannot exceed 3"):
        client.capture([{"event": "three"}, {"event": "four"}])

    assert client.flush().accepted == 2
    client.close()
    http.close()


def test_single_oversized_event_is_retained_and_surfaced_from_flush() -> None:
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return success(request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=3600,
        http_client=http,
    )
    client.capture(
        {
            "event": "too-large",
            "properties": {"payload": "x" * MAX_ENCODED_BODY_BYTES},
        }
    )

    with pytest.raises(ValidationError, match="HTTP request body"):
        client.flush()

    assert not called
    with client._condition:
        client._queue.clear()
        client._pending_event_ids.clear()
        client._pending_count = 0
        client._condition.notify_all()
    client.close()
    http.close()


def test_capture_has_no_per_call_idempotency_option() -> None:
    client, http = sync_client()

    with pytest.raises(TypeError, match="idempotency_key"):
        client.capture(  # type: ignore[call-arg]
            {"event": "x"},
            idempotency_key="caller-key",
        )

    client.close()
    http.close()


@pytest.mark.asyncio
async def test_async_capture_has_no_per_call_idempotency_option() -> None:
    client = AsyncTrafficWar("key")

    with pytest.raises(TypeError, match="idempotency_key"):
        await client.capture(  # type: ignore[call-arg]
            {"event": "x"},
            idempotency_key="caller-key",
        )

    await client.aclose()


def test_runtime_version_matches_distribution_metadata() -> None:
    assert __version__ == version("trafficwar")
    assert math.isfinite(DEFAULT_FLUSH_INTERVAL)
