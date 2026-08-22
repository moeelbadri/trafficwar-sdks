import gzip
import json
import threading
import time
import uuid
from typing import Any, Callable

import httpx
import pytest

from trafficwar import (
    MAX_BATCH_EVENTS,
    MAX_DECODED_BODY_BYTES,
    MAX_ENCODED_BODY_BYTES,
    FlushResult,
    RateLimitError,
    ServerError,
    TrafficWar,
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


def success(request: httpx.Request, suffix: str = "ok") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "status": "ok",
            "accepted": len(decoded_events(request)),
            "ingest_id": f"ing_{suffix}",
        },
    )


def make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    **kwargs: Any,
) -> tuple[TrafficWar, httpx.Client]:
    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "secret-key",
        compression="none",
        flush_interval=60,
        http_client=http,
        **kwargs,
    )
    return client, http


def run_in_thread(
    target: Callable[[], FlushResult],
) -> tuple[threading.Thread, list[FlushResult], list[Exception]]:
    results: list[FlushResult] = []
    errors: list[Exception] = []

    def run() -> None:
        try:
            results.append(target())
        except Exception as error:
            errors.append(error)

    thread = threading.Thread(target=run)
    thread.start()
    return thread, results, errors


def test_capture_queues_without_immediate_http_and_flushes_one_bare_array() -> None:
    requests: list[httpx.Request] = []
    client, http = make_client(lambda request: requests.append(request) or success(request, "one"))

    result = client.capture({"event": "checkout", "latency_ms": 12.5})

    assert result is None
    assert requests == []
    flushed = client.flush()
    assert flushed.accepted == 1
    assert len(flushed.batches) == 1
    assert requests[0].url.path == "/v1/server/batch"
    events = decoded_events(requests[0])
    assert events[0]["event"] == "checkout"
    assert uuid.UUID(events[0]["event_id"]).version == 7
    assert requests[0].headers["idempotency-key"] == flushed.batches[0].idempotency_key
    assert uuid.UUID(flushed.batches[0].idempotency_key).version == 7

    assert client.close() == FlushResult(accepted=0, batches=())
    assert not http.is_closed
    http.close()


def test_capture_accepts_iterables_and_deprecated_batch_alias() -> None:
    requests: list[httpx.Request] = []
    client, http = make_client(lambda request: requests.append(request) or success(request))

    client.capture({"event": str(index)} for index in range(2))
    with pytest.deprecated_call(match="capture_batch"):
        assert client.capture_batch([{"event": "legacy"}]) is None
    assert requests == []

    assert client.flush().accepted == 3
    assert [event["event"] for event in decoded_events(requests[0])] == ["0", "1", "legacy"]
    client.close()
    http.close()


def test_capture_deeply_snapshots_and_preserves_uuid_override() -> None:
    sent: list[dict[str, Any]] = []
    override = "550E8400-E29B-41D4-A716-446655440000"

    def handler(request: httpx.Request) -> httpx.Response:
        sent.extend(decoded_events(request))
        return success(request)

    client, http = make_client(handler)
    nested = {"original": True, "values": [1, 2]}
    event: dict[str, Any] = {
        "event": "snapshot",
        "event_id": override,
        "properties": nested,
    }

    client.capture(event)
    event["event"] = "mutated"
    nested["original"] = False
    nested["values"].append(3)
    client.flush()

    assert len(sent) == 1
    assert sent[0]["event"] == "snapshot"
    assert sent[0]["event_id"] == override
    assert sent[0]["properties"] == {"original": True, "values": [1, 2]}
    assert isinstance(sent[0]["timestamp"], str)
    assert sent[0]["timestamp"].endswith("Z")
    assert event["event_id"] == override
    client.close()
    http.close()


def test_timer_is_one_shot_from_first_pending_event() -> None:
    called = threading.Event()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        called.set()
        return success(request)

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=0.03,
        http_client=http,
    )
    client.capture({"event": "first"})
    first_deadline = client._deadline
    client.capture({"event": "second"})

    assert client._deadline == first_deadline
    assert called.wait(1)
    assert [event["event"] for event in decoded_events(requests[0])] == ["first", "second"]
    client.close()
    http.close()


def test_10000_pending_events_start_an_immediate_background_drain() -> None:
    started = threading.Event()
    release = threading.Event()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        started.set()
        assert release.wait(2)
        return success(request)

    client, http = make_client(handler)
    client.capture({"event": f"threshold-{index}"} for index in range(MAX_BATCH_EVENTS))

    assert started.wait(2)
    assert len(decoded_events(requests[0])) == MAX_BATCH_EVENTS
    thread, results, errors = run_in_thread(client.flush)
    time.sleep(0.01)
    release.set()
    thread.join(5)
    assert errors == []
    assert results[0].accepted == MAX_BATCH_EVENTS
    client.close()
    http.close()


def test_more_than_10000_events_split_into_fixed_ceiling_batches() -> None:
    started = threading.Event()
    release = threading.Event()
    sizes: list[int] = []
    keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sizes.append(len(decoded_events(request)))
        keys.append(request.headers["idempotency-key"])
        if len(sizes) == 1:
            started.set()
            assert release.wait(2)
        return success(request, str(len(sizes)))

    client, http = make_client(handler)
    client.capture({"event": f"chunk-{index}"} for index in range(25_001))
    assert started.wait(2)
    thread, results, errors = run_in_thread(client.flush)
    time.sleep(0.01)
    release.set()
    thread.join(5)

    assert not thread.is_alive()
    assert errors == []
    assert results[0].accepted == 25_001
    assert sizes == [10_000, 10_000, 5_001]
    assert len(set(keys)) == 3
    assert keys == sorted(keys)
    client.close()
    http.close()


def test_batches_split_below_identity_wire_limit() -> None:
    requests: list[httpx.Request] = []
    client, http = make_client(lambda request: requests.append(request) or success(request))
    client.capture(
        {
            "event": f"wire-{index}",
            "properties": {"payload": "x" * 300_000},
        }
        for index in range(10)
    )

    result = client.flush()

    assert len(requests) > 1
    assert all(len(request.content) <= MAX_ENCODED_BODY_BYTES for request in requests)
    assert sum(len(decoded_events(request)) for request in requests) == 10
    assert result.accepted == 10
    client.close()
    http.close()


def test_gzip_batches_split_below_decoded_limit() -> None:
    requests: list[httpx.Request] = []
    http = httpx.Client(
        transport=httpx.MockTransport(lambda request: requests.append(request) or success(request))
    )
    client = TrafficWar(
        "key",
        compression="gzip",
        flush_interval=60,
        http_client=http,
    )
    client.capture(
        {
            "event": f"decoded-{index}",
            "properties": {"payload": "compressible" * 40_000},
        }
        for index in range(20)
    )

    result = client.flush()

    assert len(requests) > 1
    assert all(len(decoded_body(request)) <= MAX_DECODED_BODY_BYTES for request in requests)
    assert result.accepted == 20
    client.close()
    http.close()


def test_concurrent_flushes_singleflight_and_include_new_captures() -> None:
    started = threading.Event()
    release = threading.Event()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            started.set()
            assert release.wait(2)
        return success(request, str(len(requests)))

    client, http = make_client(handler)
    client.capture({"event": "first"})
    thread_a, results_a, errors_a = run_in_thread(client.flush)
    assert started.wait(2)
    thread_b, results_b, errors_b = run_in_thread(client.flush)
    client.capture({"event": "during-flight"})
    release.set()
    thread_a.join(5)
    thread_b.join(5)

    assert errors_a == errors_b == []
    assert results_a[0] is results_b[0]
    assert results_a[0].accepted == 2
    assert len(requests) == 2
    assert decoded_events(requests[1])[0]["event"] == "during-flight"
    client.close()
    http.close()


def test_drain_clears_consumed_immediate_trigger_before_next_timer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("trafficwar._client.MAX_BATCH_EVENTS", 3)
    started = threading.Event()
    release = threading.Event()
    lone_sent = threading.Event()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            started.set()
            assert release.wait(2)
        elif len(requests) == 3:
            lone_sent.set()
        return success(request, str(len(requests)))

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=0.05,
        http_client=http,
    )
    client.capture({"event": "in-flight"})
    thread, results, errors = run_in_thread(client.flush)
    assert started.wait(2)

    client.capture([{"event": f"queued-{index}"} for index in range(3)])
    release.set()
    thread.join(5)

    assert errors == []
    assert results[0].accepted == 4
    assert len(requests) == 2
    assert client._pending_count == 0
    assert not client._immediate

    client.capture({"event": "timer-only"})
    assert not lone_sent.wait(0.015)
    assert lone_sent.wait(1)
    client.close()
    http.close()


def test_queue_cap_counts_in_flight_events() -> None:
    started = threading.Event()
    release = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        assert release.wait(2)
        return success(request)

    client, http = make_client(handler, max_queue_size=2)
    client.capture([{"event": "one"}, {"event": "two"}])
    thread, _results, errors = run_in_thread(client.flush)
    assert started.wait(2)

    with pytest.raises(ValidationError, match="queue cannot exceed 2"):
        client.capture({"event": "overflow"})

    release.set()
    thread.join(5)
    assert errors == []
    client.close()
    http.close()


def test_pending_event_ids_are_atomic_retained_and_reusable_after_ack() -> None:
    pending_id = str(uuid.uuid4())
    atomic_id = str(uuid.uuid4())
    failing = True

    def handler(request: httpx.Request) -> httpx.Response:
        if failing:
            return httpx.Response(503, json={"status": "error", "error": "offline"})
        return success(request)

    client, http = make_client(handler, max_retries=0)
    client.capture({"event": "original", "event_id": pending_id})

    with pytest.raises(ValidationError, match="unacknowledged"):
        client.capture(
            [
                {"event": "must-not-queue", "event_id": atomic_id},
                {"event": "duplicate", "event_id": pending_id},
            ]
        )
    assert client._pending_count == 1
    assert client._pending_event_ids == {pending_id}

    with pytest.raises(ServerError):
        client.flush()
    with pytest.raises(ValidationError, match="unacknowledged"):
        client.capture({"event": "still-duplicate", "event_id": pending_id})
    assert client._pending_event_ids == {pending_id}

    failing = False
    assert client.flush().accepted == 1
    assert client._pending_event_ids == set()

    client.capture({"event": "reused-after-ack", "event_id": pending_id})
    assert client.flush().accepted == 1
    assert client._pending_event_ids == set()
    client.close()
    http.close()


def test_http_retry_reuses_exact_body_and_uuidv7_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            return httpx.Response(
                503,
                headers={"Retry-After": "0"},
                json={"status": "pending", "error": "durable timeout"},
            )
        return success(request)

    monkeypatch.setattr("trafficwar._client.time.sleep", lambda _seconds: None)
    monkeypatch.setattr("trafficwar._base.random.uniform", lambda _start, _end: 0.0)
    client, http = make_client(handler, max_retries=1)
    client.capture({"event": "retry", "properties": {"value": "x" * 2000}})

    result = client.flush()

    assert len(requests) == 2
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert uuid.UUID(result.batches[0].idempotency_key).version == 7
    client.close()
    http.close()


def test_background_failure_retains_batch_and_invokes_callback() -> None:
    requests: list[httpx.Request] = []
    errors: list[Exception] = []
    callback_seen = threading.Event()
    release_callback = threading.Event()
    failing = True

    def on_error(error: Exception) -> None:
        errors.append(error)
        callback_seen.set()
        assert release_callback.wait(2)

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if failing:
            return httpx.Response(
                503,
                json={"status": "error", "error": "temporarily unavailable"},
            )
        return success(request, "recovered")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=0.01,
        max_retries=0,
        on_error=on_error,
        http_client=http,
    )
    client.capture({"event": "retained", "properties": {"n": 1}})
    assert callback_seen.wait(2)

    failing = False
    result = client.flush()
    release_callback.set()

    assert result.accepted == 1
    assert len(errors) == 1
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    client.close()
    http.close()


def test_background_failure_retries_on_a_new_one_shot_timer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("trafficwar._client.MAX_BATCH_EVENTS", 1)
    requests: list[httpx.Request] = []
    first_failed = threading.Event()
    delivered = threading.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if len(requests) == 1:
            first_failed.set()
            return httpx.Response(503, json={"status": "error", "error": "offline"})
        delivered.set()
        return success(request, "automatic-retry")

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=0.05,
        max_retries=0,
        http_client=http,
    )
    client.capture({"event": "automatic-retry"})

    assert first_failed.wait(2)
    time.sleep(0.01)
    assert len(requests) == 1
    assert delivered.wait(2)
    deadline = time.monotonic() + 2
    with client._condition:
        while client._pending_count > 0 and time.monotonic() < deadline:
            client._condition.wait(timeout=0.01)
        assert client._pending_count == 0
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert client.flush() == FlushResult(accepted=0, batches=())
    client.close()
    http.close()


def test_every_manual_flush_resurfaces_retained_failure() -> None:
    requests: list[httpx.Request] = []
    failing = True

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if failing:
            raise httpx.ConnectError("offline", request=request)
        return success(request, "recovered")

    client, http = make_client(handler, max_retries=0)
    client.capture({"event": "offline"})

    with pytest.raises(TransportError):
        client.flush()
    with pytest.raises(TransportError):
        client.flush()
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]

    failing = False
    assert client.flush().accepted == 1
    client.close()
    http.close()


def test_retryable_status_and_rate_limit_mapping_are_preserved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    quota = True

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                503,
                headers={"Retry-After": "0"},
                json={"status": "error", "error": "retry"},
            )
        if quota:
            return httpx.Response(
                429,
                headers={"Retry-After": "17"},
                json={
                    "status": "error",
                    "error": "quota exceeded",
                    "period": "monthly",
                    "used": 990,
                    "limit": 1000,
                    "remaining_events": 10,
                    "batch_events": 20,
                    "retry_after_secs": 17,
                },
            )
        return success(request)

    monkeypatch.setattr("trafficwar._client.time.sleep", lambda _seconds: None)
    client, http = make_client(handler, max_retries=1)
    client.capture([{"event": "one"}, {"event": "two"}])

    with pytest.raises(RateLimitError) as raised:
        client.flush()
    assert attempts == 2
    assert raised.value.period == "monthly"
    assert raised.value.retry_after == 17.0

    quota = False
    assert client.flush().accepted == 2
    client.close()
    http.close()


def test_transport_failure_retains_internal_idempotency_key() -> None:
    failing = True

    def handler(request: httpx.Request) -> httpx.Response:
        if failing:
            raise httpx.ReadTimeout("slow", request=request)
        return success(request)

    client, http = make_client(handler, max_retries=0)
    client.capture({"event": "timeout"})

    with pytest.raises(TransportError) as raised:
        client.flush()

    assert raised.value.idempotency_key is not None
    assert uuid.UUID(raised.value.idempotency_key).version == 7
    failing = False
    client.flush()
    client.close()
    http.close()


def test_close_drains_seals_closes_owned_resources_and_is_idempotent() -> None:
    http = httpx.Client(transport=httpx.MockTransport(lambda request: success(request, "close")))
    client = TrafficWar(
        "key",
        compression="none",
        flush_interval=60,
        http_client=http,
    )
    client._owns_client = True
    client.capture({"event": "close"})

    result = client.close()

    assert result.accepted == 1
    assert client._pending_event_ids == set()
    assert http.is_closed
    with pytest.raises(RuntimeError, match="closed"):
        client.capture({"event": "late"})
    assert client.close() == _empty_result()


def _empty_result() -> FlushResult:
    return FlushResult(accepted=0, batches=())


def test_close_rejects_capture_while_in_progress_without_double_send() -> None:
    started = threading.Event()
    release = threading.Event()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        started.set()
        assert release.wait(2)
        return success(request)

    client, http = make_client(handler)
    client.capture({"event": "closing"})
    thread, results, errors = run_in_thread(client.close)
    assert started.wait(2)

    with pytest.raises(RuntimeError, match="closing"):
        client.capture({"event": "late"})

    release.set()
    thread.join(5)
    assert errors == []
    assert results[0].accepted == 1
    assert len(requests) == 1
    http.close()


def test_failed_close_retains_work_and_remains_retryable() -> None:
    failing = True
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if failing:
            return httpx.Response(503, json={"status": "error", "error": "maintenance"})
        return success(request, str(len(requests)))

    client, http = make_client(handler, max_retries=0)
    client.capture({"event": "before-failed-close"})

    with pytest.raises(ServerError):
        client.close()
    assert len(client._pending_event_ids) == 1
    client.capture({"event": "after-failed-close"})
    assert len(client._pending_event_ids) == 2

    failing = False
    result = client.close()

    assert result.accepted == 2
    assert client._pending_event_ids == set()
    assert len(requests) == 3
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert decoded_events(requests[2])[0]["event"] == "after-failed-close"
    assert not http.is_closed
    http.close()
