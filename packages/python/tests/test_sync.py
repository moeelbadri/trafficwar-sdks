import gzip

import httpx
import pytest

from trafficwar import (
    ConflictError,
    RateLimitError,
    ResponseError,
    ServerError,
    TrafficWar,
    TransportError,
)


def success(accepted: int = 1, ingest_id: str = "ing_123") -> httpx.Response:
    return httpx.Response(
        200,
        json={"status": "ok", "accepted": accepted, "ingest_id": ingest_id},
    )


def test_capture_sends_exact_server_request() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return success()

    http = httpx.Client(transport=httpx.MockTransport(handler))
    client = TrafficWar("secret-key", http_client=http, compression="none")

    result = client.capture(
        {"event": "checkout", "latency_ms": 12.5},
        idempotency_key="checkout-1",
    )

    assert result.status == "ok"
    assert result.accepted == 1
    assert result.ingest_id == "ing_123"
    assert result.idempotency_key == "checkout-1"
    assert len(requests) == 1
    request = requests[0]
    assert str(request.url) == "https://ingest.trafficwar.tech/v1/server/capture"
    assert request.method == "POST"
    assert request.content == b'{"event":"checkout","latency_ms":12.5}'
    assert request.headers["authorization"] == "Bearer secret-key"
    assert request.headers["content-type"] == "application/json"
    assert request.headers["idempotency-key"] == "checkout-1"
    assert request.headers["user-agent"] == "trafficwar-python/1.0.0"
    assert request.headers["x-trafficwar-sdk"] == "python/1.0.0"
    assert "origin" not in request.headers
    assert "content-encoding" not in request.headers
    assert request.extensions["timeout"] == {
        "connect": 30.0,
        "read": 30.0,
        "write": 30.0,
        "pool": 30.0,
    }


def test_capture_batch_sends_a_bare_array_and_does_not_generate_event_ids() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return success(accepted=2)

    client = TrafficWar(
        "key",
        base_url="https://example.test/root/",
        compression="none",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    events = [{"event": "b"}, {"event": "a", "status_code": 201}]

    result = client.capture_batch(events)

    assert result.accepted == 2
    assert str(seen[0].url) == "https://example.test/root/v1/server/batch"
    assert seen[0].content == b'[{"event":"b"},{"event":"a","status_code":201}]'
    assert b"event_id" not in seen[0].content
    assert events == [{"event": "b"}, {"event": "a", "status_code": 201}]


def test_gzip_is_deterministic_and_decodes_to_compact_json() -> None:
    bodies: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(request.content)
        assert request.headers["content-encoding"] == "gzip"
        return success()

    client = TrafficWar(
        "key",
        compression="gzip",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )
    event = {"event": "page_view", "properties": {"unicode": "München"}}

    client.capture(event, idempotency_key="one")
    client.capture(event, idempotency_key="two")

    assert bodies[0] == bodies[1]
    assert gzip.decompress(bodies[0]) == (
        b'{"event":"page_view","properties":{"unicode":"M\xc3\xbcnchen"}}'
    )
    assert bodies[0][4:8] == b"\x00\x00\x00\x00"


def test_auto_compression_respects_threshold() -> None:
    encodings: list[str] = []
    keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        encodings.append(request.headers.get("content-encoding", "identity"))
        keys.append(request.headers["idempotency-key"])
        return success()

    client = TrafficWar(
        "key",
        compression="auto",
        compression_threshold=40,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    client.capture({"event": "x"})
    client.capture({"event": "x", "properties": {"value": "x" * 100}})

    assert encodings == ["identity", "gzip"]
    assert keys[0] != keys[1]


def test_retry_reuses_exact_body_and_automatic_key(
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
        return success()

    monkeypatch.setattr("trafficwar._client.time.sleep", lambda _seconds: None)
    monkeypatch.setattr("trafficwar._base.random.uniform", lambda _start, _end: 0.0)
    client = TrafficWar(
        "key",
        compression="gzip",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    result = client.capture({"event": "retry", "properties": {"x": "y" * 100}})

    assert len(requests) == 2
    assert requests[0].content == requests[1].content
    assert requests[0].headers["idempotency-key"] == requests[1].headers["idempotency-key"]
    assert result.idempotency_key == requests[0].headers["idempotency-key"]


@pytest.mark.parametrize("status_code", [408, 425, 500, 502, 503, 504])
def test_every_documented_status_is_retried(
    status_code: int,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                status_code,
                headers={"Retry-After": "0"},
                json={"status": "error", "error": "temporary"},
            )
        return success()

    monkeypatch.setattr("trafficwar._client.time.sleep", lambda _seconds: None)
    client = TrafficWar(
        "key",
        max_retries=1,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert client.capture({"event": "retry"}).accepted == 1
    assert attempts == 2


def test_retry_backoff_uses_exponential_full_jitter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts <= 3:
            return httpx.Response(
                500,
                json={"status": "error", "error": "temporary"},
            )
        return success()

    monkeypatch.setattr("trafficwar._base.random.uniform", lambda _start, end: end)
    monkeypatch.setattr("trafficwar._client.time.sleep", sleeps.append)
    client = TrafficWar(
        "key",
        max_retries=3,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert client.capture({"event": "retry"}).accepted == 1
    assert sleeps == [0.5, 1.0, 2.0]


def test_exhausted_server_error_retains_response_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0
    sleeps: list[float] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            503,
            headers={"Retry-After": "1"},
            json={
                "status": "pending",
                "error": "durability timeout",
                "ingest_id": "ing_pending",
            },
        )

    monkeypatch.setattr("trafficwar._client.time.sleep", sleeps.append)
    client = TrafficWar(
        "key",
        max_retries=1,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(ServerError) as raised:
        client.capture({"event": "retry"}, idempotency_key="durable-key")

    assert attempts == 2
    assert sleeps == [1.0]
    assert raised.value.status_code == 503
    assert raised.value.status == "pending"
    assert raised.value.retry_after == 1.0
    assert raised.value.ingest_id == "ing_pending"
    assert raised.value.idempotency_key == "durable-key"


def test_retry_after_above_bound_is_surfaced_without_sleeping() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            503,
            headers={"Retry-After": "99999999999999999999"},
            json={"status": "pending", "error": "try much later"},
        )

    client = TrafficWar(
        "key",
        max_retries=3,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(ServerError) as raised:
        client.capture({"event": "bounded"}, idempotency_key="bounded-key")

    assert attempts == 1
    assert raised.value.retry_after == 1e20
    assert raised.value.idempotency_key == "bounded-key"


def test_transport_timeout_is_retried_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ReadTimeout("timed out", request=request)
        return success()

    monkeypatch.setattr("trafficwar._client.time.sleep", lambda _seconds: None)
    client = TrafficWar(
        "key",
        max_retries=1,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    assert client.capture({"event": "retry"}).accepted == 1
    assert attempts == 2


def test_transport_error_retains_idempotency_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline", request=request)

    monkeypatch.setattr("trafficwar._client.time.sleep", lambda _seconds: None)
    client = TrafficWar(
        "key",
        max_retries=1,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(TransportError) as raised:
        client.capture({"event": "retry"}, idempotency_key="stable")

    assert raised.value.idempotency_key == "stable"
    assert raised.value.status_code is None
    assert raised.value.details == {"exception": "ConnectError"}


def test_rate_limit_is_structured_and_never_retried() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
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
                "ingest_id": "ing_rate",
            },
        )

    client = TrafficWar(
        "key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(RateLimitError) as raised:
        client.capture_batch(
            [{"event": "a"}, {"event": "b"}],
            idempotency_key="quota-key",
        )

    error = raised.value
    assert attempts == 1
    assert str(error) == "quota exceeded"
    assert error.status_code == 429
    assert error.status == "error"
    assert error.period == "monthly"
    assert error.used == 990
    assert error.limit == 1000
    assert error.remaining_events == 10
    assert error.batch_events == 20
    assert error.retry_after_secs == 17
    assert error.retry_after == 17.0
    assert error.ingest_id == "ing_rate"
    assert error.idempotency_key == "quota-key"


def test_conflict_is_never_retried() -> None:
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            409,
            json={"status": "error", "error": "idempotency body mismatch"},
        )

    client = TrafficWar(
        "key",
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    )

    with pytest.raises(ConflictError) as raised:
        client.capture({"event": "x"}, idempotency_key="reused")

    assert attempts == 1
    assert raised.value.status_code == 409
    assert raised.value.idempotency_key == "reused"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"status": "ok", "accepted": True, "ingest_id": "ing"},
        {"status": "ok", "accepted": 2, "ingest_id": "ing"},
        {"status": "ok", "accepted": 1, "ingest_id": ""},
        {"status": "error", "error": "unexpected"},
        ["ok", 1, "ing"],
    ],
)
def test_malformed_success_raises_response_error(payload: object) -> None:
    client = TrafficWar(
        "key",
        http_client=httpx.Client(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload))
        ),
    )

    with pytest.raises(ResponseError) as raised:
        client.capture({"event": "x"}, idempotency_key="malformed")

    assert raised.value.status_code == 200
    assert raised.value.idempotency_key == "malformed"


@pytest.mark.parametrize(
    ("body", "content_type"),
    [
        ('["not","an","object"]', "application/json"),
        ('{"status":"error"}', "application/json"),
        ('{"status":17,"error":"bad"}', "application/json"),
        ('{"status":"error","error":17}', "application/json"),
        ("<html>" + "x" * 5000, "text/html"),
    ],
)
def test_malformed_error_raises_response_error_with_bounded_body(
    body: str,
    content_type: str,
) -> None:
    client = TrafficWar(
        "key",
        max_retries=0,
        http_client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    502,
                    text=body,
                    headers={"Content-Type": content_type},
                )
            )
        ),
    )

    with pytest.raises(ResponseError) as raised:
        client.capture({"event": "x"}, idempotency_key="malformed-error")

    assert raised.value.status_code == 502
    assert raised.value.idempotency_key == "malformed-error"
    assert raised.value.details == {"body": body[:4096]}


def test_injected_client_defaults_are_isolated_and_client_is_not_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
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

    http = httpx.Client(
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

    with TrafficWar("key", http_client=http) as client:
        client.capture({"event": "x"})

    assert not http.is_closed
    http.close()


def test_sync_context_closes_owned_client() -> None:
    client = TrafficWar("key")

    with client:
        pass

    assert client._client.is_closed
