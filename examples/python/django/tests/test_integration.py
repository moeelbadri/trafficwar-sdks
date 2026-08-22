from __future__ import annotations

import json
import math
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from uuid import UUID

import httpx
from django.test import TestCase
from greetings.telemetry import override_trafficwar_client
from trafficwar import TrafficWar

API_KEY = "tw_test_example_key_not_real"
BASE_URL = "https://trafficwar.invalid"


@contextmanager
def captured_events() -> Iterator[tuple[list[dict[str, Any]], TrafficWar]]:
    events: list[dict[str, Any]] = []
    request_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
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
                "ingest_id": f"ing_django_{request_count}",
            },
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    trafficwar = TrafficWar(
        api_key=API_KEY,
        base_url=BASE_URL,
        timeout=1,
        max_retries=0,
        compression="none",
        flush_interval=60,
        http_client=http_client,
    )
    try:
        with override_trafficwar_client(trafficwar):
            yield events, trafficwar
    finally:
        trafficwar.close()
        assert not http_client.is_closed
        http_client.close()


class HelloIntegrationTests(TestCase):
    def test_seeded_greeting_is_returned_and_captured(self) -> None:
        with captured_events() as (events, trafficwar):
            response = self.client.get("/hello/Ada/")
            flushed = trafficwar.flush()
            assert flushed.accepted == 1
            assert len(flushed.batches) == 1

        assert response.status_code == 200
        assert response.json() == {"message": "Hello, Ada!"}
        assert len(events) == 1
        event = events[0]
        assert event["event"] == "hello.request"
        assert event["distinct_id"] == "Ada"
        assert event["path"] == "/hello/{name}/"
        assert event["label"] == "greeting.lookup"
        assert event["source"] == "django"
        assert event["span_kind"] == "server"
        assert event["operation_type"] == "sqlite.select"
        assert event["status_code"] == 200
        assert math.isfinite(event["latency_ms"])
        assert event["latency_ms"] >= 0
        assert event["properties"]["database"] == "sqlite"
        assert event["properties"]["found"] is True
        assert math.isfinite(event["properties"]["query_latency_ms"])

    def test_missing_greeting_returns_404_and_captures_error_status(self) -> None:
        with captured_events() as (events, trafficwar):
            response = self.client.get("/hello/Grace/")
            flushed = trafficwar.flush()
            assert flushed.accepted == 1
            assert len(flushed.batches) == 1

        assert response.status_code == 404
        assert response.json() == {"detail": "No greeting for Grace"}
        assert len(events) == 1
        event = events[0]
        assert event["distinct_id"] == "Grace"
        assert event["status_code"] == 404
        assert event["error"] == "greeting_not_found"
        assert event["properties"]["found"] is False
        assert math.isfinite(event["latency_ms"])
