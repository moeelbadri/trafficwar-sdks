import json
from typing import Any

import httpx
import pytest

from event_fixture import VALID_EVENT
from trafficwar import AsyncTrafficWar, TrafficWar, ValidationError

INVALID = (
    [
        ({key: value for key, value in VALID_EVENT.items() if key != field}, field)
        for field in VALID_EVENT
    ]
    + [
        ({**VALID_EVENT, field: value}, field)
        for field in ("event", "label", "source", "operation_type")
        for value in ("", " \t\n", None, 123)
    ]
    + [
        ({**VALID_EVENT, "latency_ms": value}, "latency_ms")
        for value in (-1, float("nan"), float("inf"), True, "0", None)
    ]
    + [
        ({**VALID_EVENT, "span_kind": value}, "span_kind")
        for value in (None, "", "SERVER", "database", [])
    ]
    + [
        ({**VALID_EVENT, "event": " HtTp ", "status_code": 200}, "http_method"),
        ({**VALID_EVENT, "event": "http", "http_method": "GET"}, "status_code"),
        (
            {**VALID_EVENT, "event": " ExTeRnAl ", "http_method": "GET", "error": " "},
            "status_code",
        ),
        (
            {**VALID_EVENT, "event": "http", "http_method": "GET", "exception": "timeout"},
            "status_code",
        ),
        (
            {**VALID_EVENT, "event": "http", "http_method": "GET", "error_code": "\t"},
            "status_code",
        ),
    ]
)


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize(("invalid", "field"), INVALID)
async def test_required_contract_rejects_atomically(
    asynchronous: bool, invalid: dict[str, Any], field: str
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "ok", "accepted": 1, "ingest_id": "test"})

    if asynchronous:
        async with (
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
            AsyncTrafficWar("key", http_client=http) as client,
        ):
            with pytest.raises(ValidationError, match=field):
                await client.capture([{**VALID_EVENT}, invalid])
            assert (await client.flush()).accepted == 0
    else:
        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as http_sync,
            TrafficWar("key", http_client=http_sync) as client_sync,
        ):
            with pytest.raises(ValidationError, match=field):
                client_sync.capture([{**VALID_EVENT}, invalid])
            assert client_sync.flush().accepted == 0
    assert requests == []


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
async def test_complete_inputs_outcomes_and_optional_trace_id(asynchronous: bool) -> None:
    events = (
        [
            {**VALID_EVENT, "span_kind": kind, "timestamp": timestamp}
            for kind in ("server", "client", "producer", "consumer", "internal")
            for timestamp in (0, 1234.5, "2026-08-21T12:00:00Z")
        ]
        + [
            {**VALID_EVENT, "event": category, "http_method": " get ", **outcome}
            for category in (" HtTp ", " ExTeRnAl ")
            for outcome in (
                {"status_code": 0},
                {"status_code": 65535},
                {"error": "timeout"},
                {"error_code": "ECONNRESET"},
            )
        ]
        + [
            {**VALID_EVENT, "event": "external"},
            {**VALID_EVENT, "trace_id": "real-shared-trace"},
            {**VALID_EVENT, "trace_id": "real-shared-trace"},
        ]
    )
    sent: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.extend(json.loads(request.content))
        return httpx.Response(
            200, json={"status": "ok", "accepted": len(events), "ingest_id": "test"}
        )

    if asynchronous:
        async with (
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
            AsyncTrafficWar("key", compression="none", http_client=http) as client,
        ):
            await client.capture(events)
            assert (await client.flush()).accepted == len(events)
    else:
        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as http_sync,
            TrafficWar("key", compression="none", http_client=http_sync) as client_sync,
        ):
            client_sync.capture(events)
            assert client_sync.flush().accepted == len(events)
    assert len(sent) == len(events)
    for original, snapshot in zip(events, sent):
        assert snapshot["event"] == original["event"]
        assert snapshot["timestamp"] == original["timestamp"]
        if "http_method" in original:
            assert snapshot["http_method"] == "GET"
            assert original["http_method"] == " get "
        if "trace_id" in original:
            assert snapshot["trace_id"] == original["trace_id"]
        else:
            assert "trace_id" not in snapshot
