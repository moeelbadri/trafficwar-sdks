from __future__ import annotations

import json
import math
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import httpx
from django.test import TestCase
from trafficwar import TrafficWar

from greetings.telemetry import override_trafficwar_client

API_KEY = "tw_test_example_key_not_real"
BASE_URL = "https://trafficwar.invalid"


@contextmanager
def captured_events() -> Iterator[list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
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
                "ingest_id": f"ing_django_{len(events)}",
            },
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handler))
    trafficwar = TrafficWar(
        api_key=API_KEY,
        base_url=BASE_URL,
        timeout=1,
        max_retries=0,
        compression="none",
        http_client=http_client,
    )
    try:
        with override_trafficwar_client(trafficwar):
            yield events
    finally:
        trafficwar.close()
        assert not http_client.is_closed
        http_client.close()


class HelloIntegrationTests(TestCase):
    def test_seeded_greeting_is_returned_and_captured(self) -> None:
        with captured_events() as events:
            response = self.client.get("/hello/Ada/")

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
        with captured_events() as events:
            response = self.client.get("/hello/Grace/")

        assert response.status_code == 404
        assert response.json() == {"detail": "No greeting for Grace"}
        assert len(events) == 1
        event = events[0]
        assert event["distinct_id"] == "Grace"
        assert event["status_code"] == 404
        assert event["error"] == "greeting_not_found"
        assert event["properties"]["found"] is False
        assert math.isfinite(event["latency_ms"])
