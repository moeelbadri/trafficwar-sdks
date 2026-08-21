from __future__ import annotations

import json
import math
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
from asgi_lifespan import LifespanManager
from trafficwar import AsyncTrafficWar

from app.main import create_app

API_KEY = "tw_test_example_key_not_real"
BASE_URL = "https://trafficwar.invalid"


@asynccontextmanager
async def running_example() -> AsyncIterator[
    tuple[httpx.AsyncClient, list[dict[str, Any]]]
]:
    events: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/v1/server/capture"
        assert request.headers["authorization"] == f"Bearer {API_KEY}"
        assert request.headers["content-type"] == "application/json"
        assert "origin" not in request.headers

        body = json.loads(request.content)
        assert isinstance(body, dict)
        events.append(body)
        return httpx.Response(
            200,
            json={
                "status": "ok",
                "accepted": 1,
                "ingest_id": f"ing_fastapi_{len(events)}",
            },
        )

    outbound_http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    trafficwar = AsyncTrafficWar(
        api_key=API_KEY,
        base_url=BASE_URL,
        timeout=1,
        max_retries=0,
        compression="none",
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
                yield app_client, events

        # The lifespan must not close the caller-injected SDK.
        result = await trafficwar.capture({"event": "ownership.probe"})
        assert result.accepted == 1
        assert events[-1]["event"] == "ownership.probe"
    finally:
        await trafficwar.aclose()
        assert not outbound_http.is_closed
        await outbound_http.aclose()


@pytest.mark.asyncio
async def test_seeded_greeting_is_returned_and_captured() -> None:
    async with running_example() as (client, events):
        response = await client.get("/hello/Ada")

        assert response.status_code == 200
        assert response.json() == {"message": "Hello, Ada!"}
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
    async with running_example() as (client, events):
        response = await client.get("/hello/Grace")

        assert response.status_code == 404
        assert response.json() == {"detail": "No greeting for Grace"}
        assert len(events) == 1
        event = events[0]
        assert event["distinct_id"] == "Grace"
        assert event["status_code"] == 404
        assert event["error"] == "greeting_not_found"
        assert event["properties"]["found"] is False
        assert math.isfinite(event["latency_ms"])
