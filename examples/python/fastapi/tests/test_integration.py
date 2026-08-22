from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import httpx
import pytest
from app.main import create_app
from asgi_lifespan import LifespanManager
from trafficwar import AsyncTrafficWar

API_KEY = "tw_test_example_key_not_real"
BASE_URL = "https://trafficwar.invalid"


@asynccontextmanager
async def running_example() -> AsyncIterator[
    tuple[httpx.AsyncClient, list[dict[str, Any]], AsyncTrafficWar]
]:
    events: list[dict[str, Any]] = []
    request_count = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal request_count
        assert request.method == "POST"
        assert request.url.path == "/v1/server/batch"
        assert request.headers["authorization"] == f"Bearer {API_KEY}"
        assert request.headers["content-type"] == "application/json"
        assert "origin" not in request.headers

        body = json.loads(request.content)
        assert isinstance(body, list)
        assert body
        for event in body:
            assert isinstance(event, dict)
            event_id = UUID(event["event_id"])
            assert event_id.version == 7
            assert str(event_id) == event["event_id"]
            events.append(event)
        request_count += 1
        return httpx.Response(
            200,
            json={
                "status": "ok",
                "accepted": len(body),
                "ingest_id": f"ing_fastapi_{request_count}",
            },
        )

    outbound_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    trafficwar = AsyncTrafficWar(
        api_key=API_KEY,
        base_url=BASE_URL,
        timeout=1,
        max_retries=0,
        compression="none",
        flush_interval=60,
        http_client=outbound_http,
    )
    application = create_app(
        trafficwar=trafficwar,
        database_path=":memory:",
    )

    try:
        async with LifespanManager(application):
            app_transport = httpx.ASGITransport(app=application)
            async with httpx.AsyncClient(
                transport=app_transport,
                base_url="http://testserver",
            ) as app_client:
                yield app_client, events, trafficwar

        # The lifespan must not close the caller-injected SDK.
        await trafficwar.capture({"event": "ownership.probe"})
        result = await trafficwar.flush()
        assert result.accepted == 1
        assert events[-1]["event"] == "ownership.probe"
    finally:
        await trafficwar.aclose()
        assert not outbound_http.is_closed
        await outbound_http.aclose()


@pytest.mark.asyncio
async def test_seeded_greeting_is_returned_and_captured() -> None:
    async with running_example() as (client, events, trafficwar):
        response = await client.get("/hello/Ada")

        assert response.status_code == 200
        assert response.json() == {"message": "Hello, Ada!"}
        flushed = await trafficwar.flush()
        assert flushed.accepted == 1
        assert len(flushed.batches) == 1
        assert len(events) == 1
        event = events[0]
        assert event["event"] == "hello.request"
        assert event["distinct_id"] == "Ada"
        assert event["path"] == "/hello/{name}"
        assert event["label"] == "greeting.lookup"
        assert event["source"] == "fastapi"
        assert event["span_kind"] == "server"
        assert event["operation_type"] == "sqlite.select"
        assert event["status_code"] == 200
        assert math.isfinite(event["latency_ms"])
        assert event["latency_ms"] >= 0
        assert event["properties"]["database"] == "sqlite"
        assert event["properties"]["found"] is True
        assert math.isfinite(event["properties"]["query_latency_ms"])


@pytest.mark.asyncio
async def test_missing_greeting_returns_404_and_captures_error_status() -> None:
    async with running_example() as (client, events, trafficwar):
        response = await client.get("/hello/Grace")

        assert response.status_code == 404
        assert response.json() == {"detail": "No greeting for Grace"}
        flushed = await trafficwar.flush()
        assert flushed.accepted == 1
        assert len(flushed.batches) == 1
        assert len(events) == 1
        event = events[0]
        assert event["distinct_id"] == "Grace"
        assert event["status_code"] == 404
        assert event["error"] == "greeting_not_found"
        assert event["properties"]["found"] is False
        assert math.isfinite(event["latency_ms"])
