# TrafficWar server SDKs

Official server-side SDKs for sending events to
[TrafficWar](https://trafficwar.tech).

- Node.js: [`@trafficwar/node`](packages/node)
- Python: [`trafficwar`](packages/python)

These packages target trusted backend processes. They send bare arrays to
`https://ingest.trafficwar.tech/v1/server/batch`, never the browser/CORS routes.

## Node.js

```bash
npm install @trafficwar/node
# or
pnpm add @trafficwar/node
# or
bun add @trafficwar/node
```

```ts
import { TrafficWar } from "@trafficwar/node";

const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
});

trafficwar.capture({
  event: "http",
  http_method: "GET",
  label: "Checkout",
  path: "/v1/checkout",
  source: "backend-a",
  operation_type: "route.handler",
  latency_ms: 184.2,
  distinct_id: "usr_7f3a91c2",
  trace_id: "tr_1",
  properties: {
    device_id: "dev_0198e743-a2c4-7c21",
  },
});

trafficwar.capture([
  {
    event: "database",
    label: "Checkout",
    path: "/v1/checkout",
    source: "db-primary",
    operation_type: "postgres.select",
    latency_ms: 48.2,
    distinct_id: "usr_7f3a91c2",
    trace_id: "tr_1",
  },
  {
    event: "redis",
    label: "Checkout",
    path: "/v1/checkout",
    source: "redis-1",
    operation_type: "redis.get",
    latency_ms: 1.4,
    distinct_id: "usr_7f3a91c2",
    trace_id: "tr_1",
  },
  {
    event: "s3",
    label: "Checkout",
    path: "/v1/checkout",
    source: "receipts.ovh-s3",
    operation_type: "s3.put_object",
    latency_ms: 22.0,
    distinct_id: "usr_7f3a91c2",
    trace_id: "tr_1",
  },
]);

const flushed = await trafficwar.close();
console.log(flushed.accepted, flushed.batches.length);
```

Use a stable pseudonymous `distinct_id` derived by the application backend,
not a raw email address. Keep a separate device identifier in `properties`
when the same actor may use multiple devices.

Application failures should keep their first-class outcome fields and place
the complete stack trace in `properties`:

```ts
try {
  await submitOrder();
} catch (caught) {
  const error = caught instanceof Error ? caught : new Error(String(caught));

  trafficwar.capture({
    event: "http",
    label: "/checkout",
    status_code: 500,
    error: error.message,
    error_code: "CHECKOUT_FAILED",
    distinct_id: "usr_7f3a91c2",
    properties: {
      exception_type: error.name,
      stack_trace: error.stack ?? error.message,
      cause: "connection deadline exceeded",
    },
  });
}
```

Properties alone do not set `is_error`; send `error`, `error_code`, or an
error `status_code` as shown above.

Pass `debug: true` to the constructor to print safe batch lifecycle logs with
`console.debug`. Debug logging is disabled by default.

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
            "event": "http",
            "http_method": "GET",
            "label": "Checkout",
            "path": "/v1/checkout",
            "source": "backend-a",
            "operation_type": "route.handler",
            "latency_ms": 184.2,
            "distinct_id": "usr_7f3a91c2",
            "trace_id": "tr_1",
            "properties": {
                "device_id": "dev_0198e743-a2c4-7c21",
            },
        }
    )
    trafficwar.capture(
        [
            {
                "event": "database",
                "label": "Checkout",
                "path": "/v1/checkout",
                "source": "db-primary",
                "operation_type": "postgres.select",
                "latency_ms": 48.2,
                "distinct_id": "usr_7f3a91c2",
                "trace_id": "tr_1",
            },
            {
                "event": "redis",
                "label": "Checkout",
                "path": "/v1/checkout",
                "source": "redis-1",
                "operation_type": "redis.get",
                "latency_ms": 1.4,
                "distinct_id": "usr_7f3a91c2",
                "trace_id": "tr_1",
            },
            {
                "event": "s3",
                "label": "Checkout",
                "path": "/v1/checkout",
                "source": "receipts.ovh-s3",
                "operation_type": "s3.put_object",
                "latency_ms": 22.0,
                "distinct_id": "usr_7f3a91c2",
                "trace_id": "tr_1",
            },
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
            {
                "event": "http",
                "http_method": "GET",
                "label": "Checkout",
                "path": "/v1/checkout",
                "source": "backend-a",
                "operation_type": "route.handler",
                "latency_ms": 184.2,
                "distinct_id": "usr_7f3a91c2",
                "trace_id": "tr_1",
                "properties": {
                    "device_id": "dev_0198e743-a2c4-7c21",
                },
            }
        )
        await trafficwar.capture(
            [
                {
                    "event": "database",
                    "label": "Checkout",
                    "path": "/v1/checkout",
                    "source": "db-primary",
                    "operation_type": "postgres.select",
                    "latency_ms": 48.2,
                    "distinct_id": "usr_7f3a91c2",
                    "trace_id": "tr_1",
                },
                {
                    "event": "redis",
                    "label": "Checkout",
                    "path": "/v1/checkout",
                    "source": "redis-1",
                    "operation_type": "redis.get",
                    "latency_ms": 1.4,
                    "distinct_id": "usr_7f3a91c2",
                    "trace_id": "tr_1",
                },
                {
                    "event": "s3",
                    "label": "Checkout",
                    "path": "/v1/checkout",
                    "source": "receipts.ovh-s3",
                    "operation_type": "s3.put_object",
                    "latency_ms": 22.0,
                    "distinct_id": "usr_7f3a91c2",
                    "trace_id": "tr_1",
                },
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
supplies any valid UUID. Canonical `event` categories are `http`, `database`,
`redis`, and `s3`. `source` is the emitting host or dependency (`backend-a`,
`db-primary`, `redis-1`, `ovh-s3`); `label` is the human route name
(`Checkout`); `path` is the route URL (`/v1/checkout`); and `operation_type`
identifies the concrete work (`route.handler`, `postgres.select`, `redis.get`,
`s3.get_object`). For HTTP events, `http_method` is trimmed and normalized to
uppercase and must be a 1–64-character RFC HTTP token. Spans of one request
share `trace_id`. `span_kind` is separate, optional tracing semantics; it does
not replace `source`.

For S3, a provider alias such as `ovh-s3`, `aws-s3`, or `minio` creates one
provider station. Prefix it as `<bucket>.<provider>` only when the map should
separate buckets: `assets.ovh-s3` and `archive.ovh-s3` become distinct
stations, while `operation_type` values such as `s3.get_object` and
`s3.put_object` remain operation dots. The final dot is the reserved
bucket/provider separator, so provider aliases must not contain dots.

`captureBatch` and `capture_batch` remain as deprecated compatibility aliases;
new code passes arrays or iterables directly to `capture`.

Each prepared HTTP batch gets an internal idempotency key that remains stable
across retries, along with the same serialized body. Automatic delivery errors
can be observed with optional `onError` (Node) or `on_error` (Python)
callbacks. Failed batches stay queued, and a later automatic attempt, `close`,
or `aclose` retries them and surfaces any remaining error.

Applications must close clients during graceful shutdown. Node's automatic
flush timer is unref'ed, and synchronous Python's worker thread is a daemon, so
neither keeps a process alive for pending events. Close returns an aggregate
`FlushResult` with `accepted` and the per-request acknowledgements in
`batches`; `capture` never returns an `IngestResult`.

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
