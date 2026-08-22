import asyncio
import gzip
import json
import threading
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
import pytest

from trafficwar import (
    MAX_BATCH_EVENTS,
    MAX_ENCODED_BODY_BYTES,
    AsyncTrafficWar,
    FlushResult,
    ServerError,
    TransportError,
    ValidationError,
)


def decoded_body(request: httpx.Request) -> bytes:
    if request.headers.get("content-encoding") == "gzip":
        return gzip.decompress(request.content)
    return request.content


def decoded_events(request: httpx.Request) -> list[dict[str, Any]]:
    value = json.loads(decoded_body(request))
    assert isinstance(value, list)
    return value


def success(request: httpx.Request, suffix: str = "async") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "status": "ok",
            "accepted": len(decoded_events(request)),
            "ingest_id": f"ing_{suffix}",
        },
    )


def make_client(
    handler: Callable[[httpx.Request], Awaitable[httpx.Response]],
    **kwargs: Any,
) -> tuple[AsyncTrafficWar, httpx.AsyncClient]:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar(
        "async-key",
        compression="none",
        flush_interval=60,
        http_client=http,
        **kwargs,
    )
    return client, http


@pytest.mark.asyncio
async def test_async_capture_only_enqueues_then_flushes_one_bare_array() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success(request)

    client, http = make_client(handler)
    assert client._worker_task is None

    result = await client.capture({"event": "async", "status_code": 204})

    assert result is None
    assert requests == []
    assert client._worker_task is not None
    flushed = await client.flush()
    assert flushed.accepted == 1
    assert requests[0].url.path == "/v1/server/batch"
    event_id = decoded_events(requests[0])[0]["event_id"]
    assert uuid.UUID(event_id).version == 7
    assert uuid.UUID(flushed.batches[0].idempotency_key).version == 7

    assert await client.aclose() == FlushResult(accepted=0, batches=())
    assert not http.is_closed
    await http.aclose()


@pytest.mark.asyncio
async def test_async_capture_accepts_generator_and_deprecated_alias() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success(request)

    client, http = make_client(handler)
    await client.capture({"event": str(index)} for index in range(2))
    with pytest.deprecated_call(match="capture_batch"):
        assert await client.capture_batch([{"event": "legacy"}]) is None

    result = await client.flush()
    assert result.accepted == 3
    assert len(result.batches) == 1
    assert [event["event"] for event in decoded_events(requests[0])] == ["0", "1", "legacy"]
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_preparation_runs_off_loop_and_snapshots_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loop_thread = threading.get_ident()
    preparation_threads: list[int] = []
    sent: list[dict[str, Any]] = []
    original = AsyncTrafficWar._normalize_capture_input

    def tracked(
        self: AsyncTrafficWar,
        value: Any,
        *,
        force_batch: bool = False,
    ):
        preparation_threads.append(threading.get_ident())
        return original(self, value, force_batch=force_batch)

    monkeypatch.setattr(AsyncTrafficWar, "_normalize_capture_input", tracked)

    async def handler(request: httpx.Request) -> httpx.Response:
        sent.extend(decoded_events(request))
        return success(request)

    client, http = make_client(handler)
    nested = {"values": [1, 2]}
    event = {"event": "snapshot", "properties": nested}
    await client.capture(event)
    event["event"] = "mutated"
    nested["values"].append(3)
    await client.flush()

    assert preparation_threads and preparation_threads[0] != loop_thread
    assert sent[0]["event"] == "snapshot"
    assert sent[0]["properties"] == {"values": [1, 2]}
    assert "event_id" not in event
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_timer_uses_first_pending_deadline() -> None:
    called = asyncio.Event()
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        called.set()
        return success(request)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar(
        "key",
        compression="none",
        flush_interval=0.02,
        http_client=http,
    )
    await client.capture({"event": "first"})
    first_deadline = client._deadline
    await client.capture({"event": "second"})

    assert client._deadline == first_deadline
    await asyncio.wait_for(called.wait(), timeout=1)
    assert len(decoded_events(requests[0])) == 2
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_10000_threshold_starts_background_without_blocking_capture() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        started.set()
        await release.wait()
        return success(request)

    client, http = make_client(handler)
    await client.capture({"event": f"threshold-{index}"} for index in range(MAX_BATCH_EVENTS))
    await asyncio.wait_for(started.wait(), timeout=2)
    assert len(decoded_events(requests[0])) == MAX_BATCH_EVENTS

    flushing = asyncio.create_task(client.flush())
    await asyncio.sleep(0)
    release.set()
    assert (await flushing).accepted == MAX_BATCH_EVENTS
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_inputs_over_10000_split_and_aggregate() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    sizes: list[int] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        sizes.append(len(decoded_events(request)))
        if len(sizes) == 1:
            started.set()
            await release.wait()
        return success(request, str(len(sizes)))

    client, http = make_client(handler)
    await client.capture({"event": f"chunk-{index}"} for index in range(10_001))
    await asyncio.wait_for(started.wait(), timeout=2)
    flushing = asyncio.create_task(client.flush())
    await asyncio.sleep(0)
    release.set()
    result = await flushing

    assert result.accepted == 10_001
    assert sizes == [10_000, 1]
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_wire_size_splitting() -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success(request)

    client, http = make_client(handler)
    await client.capture(
        {
            "event": f"wire-{index}",
            "properties": {"payload": "x" * 300_000},
        }
        for index in range(10)
    )

    result = await client.flush()

    assert result.accepted == 10
    assert len(requests) > 1
    assert all(len(request.content) <= MAX_ENCODED_BODY_BYTES for request in requests)
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_concurrent_flush_singleflight_and_capture_during_send() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            started.set()
            await release.wait()
        return success(request, str(len(requests)))

    client, http = make_client(handler)
    await client.capture({"event": "first"})
    first = asyncio.create_task(client.flush())
    await asyncio.wait_for(started.wait(), timeout=1)
    second = asyncio.create_task(client.flush())
    await asyncio.sleep(0)
    await client.capture({"event": "during-flight"})
    release.set()
    result_a, result_b = await asyncio.gather(first, second)

    assert result_a is result_b
    assert result_a.accepted == 2
    assert len(requests) == 2
    assert decoded_events(requests[1])[0]["event"] == "during-flight"
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_drain_clears_consumed_immediate_before_next_timer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("trafficwar._async_client.MAX_BATCH_EVENTS", 3)
    started = asyncio.Event()
    release = asyncio.Event()
    lone_sent = asyncio.Event()
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            started.set()
            await release.wait()
        elif len(requests) == 3:
            lone_sent.set()
        return success(request, str(len(requests)))

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar(
        "key",
        compression="none",
        flush_interval=0.05,
        http_client=http,
    )
    await client.capture({"event": "in-flight"})
    flushing = asyncio.create_task(client.flush())
    await asyncio.wait_for(started.wait(), timeout=1)

    await client.capture([{"event": f"queued-{index}"} for index in range(3)])
    release.set()
    result = await flushing

    assert result.accepted == 4
    assert len(requests) == 2
    assert client._pending_count == 0
    assert not client._immediate

    await client.capture({"event": "timer-only"})
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(lone_sent.wait(), timeout=0.015)
    await asyncio.wait_for(lone_sent.wait(), timeout=1)
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_queue_cap_includes_in_flight() -> None:
    started = asyncio.Event()
    release = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await release.wait()
        return success(request)

    client, http = make_client(handler, max_queue_size=2)
    await client.capture([{"event": "one"}, {"event": "two"}])
    flushing = asyncio.create_task(client.flush())
    await asyncio.wait_for(started.wait(), timeout=1)

    with pytest.raises(ValidationError, match="queue cannot exceed 2"):
        await client.capture({"event": "overflow"})

    release.set()
    await flushing
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_pending_ids_are_atomic_retained_and_reusable() -> None:
    pending_id = str(uuid.uuid4())
    atomic_id = str(uuid.uuid4())
    failing = True

    async def handler(request: httpx.Request) -> httpx.Response:
        if failing:
            return httpx.Response(503, json={"status": "error", "error": "offline"})
        return success(request)

    client, http = make_client(handler, max_retries=0)
    await client.capture({"event": "original", "event_id": pending_id})

    with pytest.raises(ValidationError, match="unacknowledged"):
        await client.capture(
            [
                {"event": "must-not-queue", "event_id": atomic_id},
                {"event": "duplicate", "event_id": pending_id},
            ]
        )
    assert client._pending_count == 1
    assert client._pending_event_ids == {pending_id}

    with pytest.raises(ServerError):
        await client.flush()
    with pytest.raises(ValidationError, match="unacknowledged"):
        await client.capture({"event": "still-duplicate", "event_id": pending_id})
    assert client._pending_event_ids == {pending_id}

    failing = False
    assert (await client.flush()).accepted == 1
    assert client._pending_event_ids == set()

    await client.capture({"event": "reused-after-ack", "event_id": pending_id})
    assert (await client.flush()).accepted == 1
    assert client._pending_event_ids == set()
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_http_retry_reuses_exact_body_and_key(
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
        return success(request)

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("trafficwar._async_client.asyncio.sleep", no_sleep)
    monkeypatch.setattr("trafficwar._base.random.uniform", lambda _start, _end: 0.0)
    client, http = make_client(handler, max_retries=1)
    await client.capture({"event": "retry"})

    result = await client.flush()

    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert uuid.UUID(result.batches[0].idempotency_key).version == 7
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_background_failure_retains_batch_and_calls_on_error() -> None:
    errors: list[Exception] = []
    error_seen = asyncio.Event()
    requests: list[httpx.Request] = []
    failing = True

    def on_error(error: Exception) -> None:
        errors.append(error)
        error_seen.set()

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if failing:
            return httpx.Response(503, json={"status": "error", "error": "offline"})
        return success(request, "recovered")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar(
        "key",
        compression="none",
        flush_interval=0.05,
        max_retries=0,
        on_error=on_error,
        http_client=http,
    )
    await client.capture({"event": "retained"})
    await asyncio.wait_for(error_seen.wait(), timeout=1)

    failing = False
    result = await client.flush()

    assert result.accepted == 1
    assert len(errors) == 1
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_background_failure_retries_on_new_timer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("trafficwar._async_client.MAX_BATCH_EVENTS", 1)
    requests: list[httpx.Request] = []
    first_failed = asyncio.Event()
    delivered = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            first_failed.set()
            return httpx.Response(503, json={"status": "error", "error": "offline"})
        delivered.set()
        return success(request, "automatic-retry")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    client = AsyncTrafficWar(
        "key",
        compression="none",
        flush_interval=0.05,
        max_retries=0,
        http_client=http,
    )
    await client.capture({"event": "automatic-retry"})

    await asyncio.wait_for(first_failed.wait(), timeout=1)
    await asyncio.sleep(0.01)
    assert len(requests) == 1
    await asyncio.wait_for(delivered.wait(), timeout=1)
    for _ in range(100):
        if client._pending_count == 0:
            break
        await asyncio.sleep(0.001)
    assert client._pending_count == 0
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert await client.flush() == FlushResult(accepted=0, batches=())
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_every_flush_resurfaces_retained_transport_failure() -> None:
    failing = True
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if failing:
            raise httpx.ReadTimeout("slow", request=request)
        return success(request)

    client, http = make_client(handler, max_retries=0)
    await client.capture({"event": "offline"})

    with pytest.raises(TransportError):
        await client.flush()
    with pytest.raises(TransportError):
        await client.flush()
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]

    failing = False
    assert (await client.flush()).accepted == 1
    await client.aclose()
    await http.aclose()


@pytest.mark.asyncio
async def test_async_aclose_joins_inflight_and_rejects_new_capture() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        started.set()
        await release.wait()
        return success(request)

    client, http = make_client(handler)
    await client.capture({"event": "closing"})
    closing = asyncio.create_task(client.aclose())
    await asyncio.wait_for(started.wait(), timeout=1)

    with pytest.raises(RuntimeError, match="closing"):
        await client.capture({"event": "late"})

    release.set()
    assert (await closing).accepted == 1
    assert client._pending_event_ids == set()
    assert len(requests) == 1
    with pytest.raises(RuntimeError, match="closed"):
        await client.capture({"event": "closed"})
    await http.aclose()


@pytest.mark.asyncio
async def test_async_failed_aclose_is_retryable_and_keeps_batch_stable() -> None:
    failing = True
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if failing:
            return httpx.Response(503, json={"status": "error", "error": "maintenance"})
        return success(request, str(len(requests)))

    client, http = make_client(handler, max_retries=0)
    await client.capture({"event": "before"})

    with pytest.raises(ServerError):
        await client.aclose()
    assert len(client._pending_event_ids) == 1
    await client.capture({"event": "after"})
    assert len(client._pending_event_ids) == 2

    failing = False
    result = await client.aclose()

    assert result.accepted == 2
    assert client._pending_event_ids == set()
    assert len(requests) == 3
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert decoded_events(requests[2])[0]["event"] == "after"
    assert not http.is_closed
    await http.aclose()


@pytest.mark.asyncio
async def test_async_context_closes_owned_client_after_empty_drain() -> None:
    client = AsyncTrafficWar("key")

    async with client:
        pass

    assert client._client.is_closed
