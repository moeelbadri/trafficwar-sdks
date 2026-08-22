# TrafficWar server SDKs

Official server-side SDKs for sending events to
[TrafficWar](https://trafficwar.tech).

- Node.js: [`@trafficwar/node`](packages/node)
- Python: [`trafficwar`](packages/python)

These packages target trusted backend processes. They send bare arrays to
`https://ingest.trafficwar.tech/v1/server/batch`, never the browser/CORS routes.

> **Breaking change:** `@trafficwar/node` 2.0.0 introduces this automatic
> batching API. The equivalent Python package update remains unreleased.

## Node.js

```bash
npm install @trafficwar/node
```

```ts
import { TrafficWar } from "@trafficwar/node";

const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
});

trafficwar.capture({
  event: "checkout.completed",
  distinct_id: "customer_123",
  latency_ms: 184.2,
  status_code: 200,
  source: "checkout-api",
  properties: { order_id: "order_456" },
});

trafficwar.capture([
  { event: "job.started", source: "worker" },
  { event: "job.finished", source: "worker", latency_ms: 42 },
]);

const flushed = await trafficwar.close();
console.log(flushed.accepted, flushed.batches.length);
```

## Synchronous Python

```bash
python -m pip install trafficwar
```

```python
import os

from trafficwar import TrafficWar

trafficwar = TrafficWar(api_key=os.environ["TRAFFICWAR_API_KEY"])
try:
    trafficwar.capture(
        {
            "event": "checkout.completed",
            "distinct_id": "customer_123",
            "latency_ms": 184.2,
            "status_code": 200,
            "source": "checkout-api",
            "properties": {"order_id": "order_456"},
        }
    )
    trafficwar.capture(
        [
            {"event": "job.started", "source": "worker"},
            {"event": "job.finished", "source": "worker", "latency_ms": 42},
        ]
    )
finally:
    flushed = trafficwar.close()

print(flushed.accepted, len(flushed.batches))
```

## Asynchronous Python

```python
import os

from trafficwar import AsyncTrafficWar


async def send_events() -> None:
    trafficwar = AsyncTrafficWar(api_key=os.environ["TRAFFICWAR_API_KEY"])
    try:
        await trafficwar.capture(
            {"event": "checkout.completed", "source": "checkout-api"}
        )
        await trafficwar.capture(
            [
                {"event": "job.started", "source": "worker"},
                {"event": "job.finished", "source": "worker"},
            ]
        )
    finally:
        flushed = await trafficwar.aclose()

    print(flushed.accepted, len(flushed.batches))
```

## Automatic batching and delivery

`capture` is the primary API: pass one event or a non-empty array (Node.js) or
iterable (Python). It validates, snapshots, and enqueues the input immediately.
Node and synchronous Python `capture` return nothing. Async Python
`await capture(...)` waits only for enqueueing, not for an HTTP request.

The queue starts an automatic flush one second after its first pending event,
or immediately when it reaches TrafficWar's fixed 10,000-event request
maximum. The default queue limit is 100,000 unacknowledged events and is
configurable. Every send is a bare JSON array to `/v1/server/batch`; larger
queued inputs are split into server-sized HTTP batches.

The SDK adds a process-monotonic RFC 9562 UUIDv7 `event_id` unless the caller
supplies any valid UUID. `source` is caller-selected origin or runtime metadata,
such as `checkout-api` or `worker`. `span_kind` is separate, optional tracing
semantics; it does not replace `source`.

`captureBatch` and `capture_batch` remain as deprecated compatibility aliases;
new code passes arrays or iterables directly to `capture`.

Each prepared HTTP batch gets an internal idempotency key that remains stable
across retries, along with the same serialized body. Automatic delivery errors
can be observed with optional `onError` (Node) or `on_error` (Python)
callbacks. Failed batches stay queued, and a later `flush`, `close`, or
`aclose` retries them and surfaces any remaining error.

Applications must close clients during graceful shutdown. Node's automatic
flush timer is unref'ed, and synchronous Python's worker thread is a daemon, so
neither keeps a process alive for pending events. `flush` and close operations
return an aggregate `FlushResult` with `accepted` and the per-request
acknowledgements in `batches`; `capture` never returns an `IngestResult`.

## Framework examples

Every example performs a real parameterized SQLite lookup, quickly enqueues an
event through the local SDK package, and closes the SDK during framework
shutdown:

- [Express](examples/node/express)
- [Elysia](examples/node/elysia)
- [NestJS](examples/node/nestjs)
- [Django](examples/python/django)
- [FastAPI](examples/python/fastapi)

Their integration tests replace only the HTTP transport with a local fake
ingest endpoint. They exercise the real SDK clients without production API
keys or network calls.

## Development

```bash
# Node.js
npm install
npm run check
npm test
npm run build
npm run smoke
npm run check:examples:node
npm run test:examples:node

# Python
uv sync --all-packages --all-extras --all-groups
uv run --directory packages/python pytest
uv run --directory examples/python/django pytest
uv run --directory examples/python/fastapi pytest
uv run --directory packages/python ruff check .
uv run --directory packages/python ruff format --check .
uv run --directory packages/python mypy src
uv build --package trafficwar
```

See each package README for its complete API and configuration.

## Security

Keep TrafficWar API keys in server-side environment variables or a secrets
manager. Do not expose either package or its key in browser bundles.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)
