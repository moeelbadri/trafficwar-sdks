import threading
from typing import Optional

import httpx
import pytest

from trafficwar import AsyncTrafficWar, RateLimitError, TransportError


def success(accepted: int = 1) -> httpx.Response:
    return httpx.Response(
        200,
        json={"status": "ok", "accepted": accepted, "ingest_id": "ing_async"},
    )


@pytest.mark.asyncio
async def test_async_capture_sends_exact_request() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success()

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar("async-key", http_client=http, compression="none")

    result = await client.capture(
        {"event": "async", "status_code": 204},
        idempotency_key="async-one",
    )

    assert result.accepted == 1
    assert result.idempotency_key == "async-one"
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://ingest.trafficwar.tech/v1/server/capture"
    assert request.content == b'{"event":"async","status_code":204}'
    assert request.headers["authorization"] == "Bearer async-key"
    assert request.headers["idempotency-key"] == "async-one"
    assert "origin" not in request.headers
    await http.aclose()


@pytest.mark.asyncio
async def test_async_batch_is_bare_array() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success(accepted=2)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar("key", http_client=http, compression="none")

    result = await client.capture_batch({"event": str(index)} for index in range(2))

    assert result.accepted == 2
    assert requests[0].url.path == "/v1/server/batch"
    assert requests[0].content == b'[{"event":"0"},{"event":"1"}]'
    await http.aclose()


@pytest.mark.asyncio
async def test_async_request_preparation_runs_off_the_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    event_loop_thread = threading.get_ident()
    preparation_threads: list[int] = []
    original = AsyncTrafficWar._prepare_capture

    def tracked_prepare(
        self: AsyncTrafficWar,
        event: dict[str, object],
        idempotency_key: Optional[str],
    ):
        preparation_threads.append(threading.get_ident())
        return original(self, event, idempotency_key)

    monkeypatch.setattr(AsyncTrafficWar, "_prepare_capture", tracked_prepare)
    http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _request: success()))
    client = AsyncTrafficWar("key", http_client=http, compression="gzip")

    await client.capture({"event": "async-worker", "properties": {"blob": "x" * 10_000}})

    assert preparation_threads
    assert preparation_threads[0] != event_loop_thread
    await http.aclose()


@pytest.mark.asyncio
async def test_async_status_retry_reuses_exact_bytes_and_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(
                503,
                headers={"Retry-After": "0"},
                json={"status": "pending", "error": "durable timeout"},
            )
        return success()

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("trafficwar._async_client.asyncio.sleep", no_sleep)
    monkeypatch.setattr("trafficwar._base.random.uniform", lambda _start, _end: 0.0)
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar("key", http_client=http, compression="gzip")

    result = await client.capture({"event": "async-retry"})

    assert len(requests) == 2
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert result.idempotency_key == requests[0].headers["idempotency-key"]
    await http.aclose()


@pytest.mark.asyncio
async def test_async_transport_retry_and_final_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    keys: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        keys.append(request.headers["idempotency-key"])
        raise httpx.ReadTimeout("slow", request=request)

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("trafficwar._async_client.asyncio.sleep", no_sleep)
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar("key", max_retries=2, http_client=http)

    with pytest.raises(TransportError) as raised:
        await client.capture({"event": "x"}, idempotency_key="async-stable")

    assert attempts == 3
    assert keys == ["async-stable"] * 3
    assert raised.value.idempotency_key == "async-stable"
    await http.aclose()


@pytest.mark.asyncio
async def test_async_rate_limit_is_not_retried() -> None:
    attempts = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            429,
            headers={"Retry-After": "9"},
            json={
                "status": "error",
                "error": "weekly quota exhausted",
                "period": "weekly",
                "used": 100,
                "limit": 100,
                "remaining_events": 0,
                "batch_events": 1,
                "retry_after_secs": 9,
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar("key", http_client=http)

    with pytest.raises(RateLimitError) as raised:
        await client.capture({"event": "x"})

    assert attempts == 1
    assert raised.value.period == "weekly"
    assert raised.value.retry_after == 9.0
    await http.aclose()


@pytest.mark.asyncio
async def test_async_context_isolates_injected_defaults_and_leaves_client_open() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert "origin" not in request.headers
        assert "content-encoding" not in request.headers
        assert "cookie" not in request.headers
        assert "x-caller-secret" not in request.headers
        assert "accept-encoding" not in request.headers
        assert request.headers["authorization"] == "Bearer key"
        assert request.headers["host"] == "ingest.trafficwar.tech"
        assert request.headers["content-length"] != "999999"
        assert str(request.url) == "https://ingest.trafficwar.tech/v1/server/capture"
        return success()

    http = httpx.AsyncClient(
        auth=("caller", "owned"),
        cookies={"session": "sensitive"},
        headers={
            "Accept-Encoding": "br",
            "Authorization": "Basic sensitive",
            "Content-Encoding": "br",
            "Content-Length": "999999",
            "Host": "attacker.example",
            "Origin": "https://browser.example",
            "X-Caller-Secret": "sensitive",
        },
        params={"caller": "owned"},
        transport=httpx.MockTransport(handler),
    )

    async with AsyncTrafficWar("key", http_client=http) as client:
        await client.capture({"event": "x"})

    assert not http.is_closed
    await http.aclose()


@pytest.mark.asyncio
async def test_async_context_closes_owned_client() -> None:
    client = AsyncTrafficWar("key")

    async with client:
        pass

    assert client._client.is_closed
