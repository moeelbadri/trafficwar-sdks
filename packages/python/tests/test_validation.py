import base64
import json
import random
from datetime import datetime, timedelta, timezone
from importlib.metadata import version
from typing import Any

import httpx
import pytest

from trafficwar import (
    AsyncTrafficWar,
    SerializationError,
    TrafficWar,
    ValidationError,
    __version__,
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
        ({"api_key": "key", "base_url": "https://example.test?"}, "query"),
        ({"api_key": "key", "base_url": "https://example.test/\npath"}, "base_url"),
        ({"api_key": "key", "timeout": 0}, "timeout"),
        ({"api_key": "key", "timeout": float("inf")}, "timeout"),
        ({"api_key": "key", "timeout": 10**1000}, "timeout"),
        ({"api_key": "key", "max_retries": -1}, "max_retries"),
        ({"api_key": "key", "max_retries": True}, "max_retries"),
        ({"api_key": "key", "compression": "br"}, "compression"),
        ({"api_key": "key", "compression": None}, "compression"),
        ({"api_key": "key", "compression_threshold": -1}, "compression_threshold"),
    ],
)
def test_constructor_validates_options(kwargs: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        TrafficWar(**kwargs)
    with pytest.raises(ValidationError, match=message):
        AsyncTrafficWar(**kwargs)


def test_injected_client_must_match_and_be_open() -> None:
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
        {"event": "x", "span_kind": {}},
    ],
)
def test_event_shape_validation_happens_before_transport(event: dict[str, Any]) -> None:
    client = TrafficWar(
        "key",
        http_client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: pytest.fail("transport must not be called")
            )
        ),
    )

    with pytest.raises(ValidationError):
        client.capture(event)  # type: ignore[arg-type]


def test_runtime_version_matches_distribution_metadata() -> None:
    assert __version__ == version("trafficwar")


@pytest.mark.parametrize("latency", [float("nan"), float("inf"), -float("inf"), True])
def test_latency_must_be_finite_number(latency: Any) -> None:
    client = TrafficWar("key")
    with pytest.raises(ValidationError, match="latency_ms"):
        client.capture({"event": "x", "latency_ms": latency})  # type: ignore[typeddict-item]
    client.close()


@pytest.mark.parametrize("status_code", [-1, 65_536, 1.5, True])
def test_status_code_must_be_uint16(status_code: Any) -> None:
    client = TrafficWar("key")
    with pytest.raises(ValidationError, match="status_code"):
        client.capture({"event": "x", "status_code": status_code})  # type: ignore[typeddict-item]
    client.close()


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
    client = TrafficWar("key")
    with pytest.raises(ValidationError, match="timestamp"):
        client.capture({"event": "x", "timestamp": timestamp})  # type: ignore[typeddict-item]
    client.close()


def test_datetime_is_normalized_without_mutating_caller() -> None:
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content)
        return httpx.Response(
            200,
            json={"status": "ok", "accepted": 1, "ingest_id": "ing_time"},
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
    client = TrafficWar(
        "key",
        compression="none",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    client.capture(event)  # type: ignore[arg-type]

    assert json.loads(bodies[0])["timestamp"] == "2026-08-21T12:30:12.123456Z"
    assert event["timestamp"] is timestamp


@pytest.mark.parametrize(
    "key",
    ["", "x" * 257, "contains space", "line\nbreak", "snowman-☃"],
)
def test_idempotency_key_validation(key: str) -> None:
    client = TrafficWar("key")
    with pytest.raises(ValidationError, match="idempotency_key"):
        client.capture({"event": "x"}, idempotency_key=key)
    client.close()


def test_batch_must_be_nonempty_iterable_with_at_most_10000_events() -> None:
    client = TrafficWar("key")

    with pytest.raises(ValidationError, match="at least one"):
        client.capture_batch([])
    with pytest.raises(ValidationError, match="iterable"):
        client.capture_batch({"event": "not-a-batch"})  # type: ignore[arg-type]
    with pytest.raises(ValidationError, match="10000"):
        client.capture_batch({"event": "x"} for _ in range(10_001))

    client.close()


def test_batch_accepts_exactly_10000_events() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"status": "ok", "accepted": 10_000, "ingest_id": "ing_max"},
        )

    client = TrafficWar(
        "key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    result = client.capture_batch({"event": "x"} for _ in range(10_000))

    assert result.accepted == 10_000


@pytest.mark.parametrize(
    "properties",
    [
        {"invalid": object()},
        {"invalid": float("nan")},
        {"invalid": {1, 2, 3}},
    ],
)
def test_json_serialization_errors_are_wrapped(properties: Any) -> None:
    client = TrafficWar("key")

    with pytest.raises(SerializationError, match="JSON serializable"):
        client.capture({"event": "x", "properties": properties})  # type: ignore[typeddict-item]

    client.close()


def test_circular_json_is_a_serialization_error() -> None:
    properties: dict[str, Any] = {}
    properties["self"] = properties
    client = TrafficWar("key")

    with pytest.raises(SerializationError, match="JSON serializable"):
        client.capture({"event": "x", "properties": properties})  # type: ignore[typeddict-item]

    client.close()


def test_identity_body_cannot_exceed_two_mib() -> None:
    client = TrafficWar("key", compression="none")

    with pytest.raises(ValidationError, match="HTTP request body"):
        client.capture({"event": "x", "properties": {"blob": "x" * (2 * 1024 * 1024)}})

    client.close()


def test_decoded_body_cannot_exceed_eight_mib_even_if_gzip_is_small() -> None:
    client = TrafficWar("key", compression="gzip")

    with pytest.raises(ValidationError, match="decoded JSON body"):
        client.capture({"event": "x", "properties": {"blob": "x" * (8 * 1024 * 1024)}})

    client.close()


def test_gzip_body_cannot_exceed_two_mib() -> None:
    blob = base64.b64encode(random.Random(0).randbytes(2_300_000)).decode("ascii")
    client = TrafficWar("key", compression="gzip")

    with pytest.raises(ValidationError, match="HTTP request body"):
        client.capture({"event": "x", "properties": {"blob": blob}})

    client.close()


def test_auto_compresses_a_large_body_even_when_threshold_is_higher() -> None:
    encodings: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        encodings.append(request.headers["content-encoding"])
        return httpx.Response(
            200,
            json={"status": "ok", "accepted": 1, "ingest_id": "ing_large"},
        )

    client = TrafficWar(
        "key",
        compression="auto",
        compression_threshold=8 * 1024 * 1024,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    client.capture({"event": "x", "properties": {"blob": "x" * (2 * 1024 * 1024)}})

    assert encodings == ["gzip"]
