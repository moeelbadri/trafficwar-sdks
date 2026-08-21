# TrafficWar server SDKs

Official server-side SDKs for sending events to
[TrafficWar](https://trafficwar.tech).

- Node.js: [`@trafficwar/node`](packages/node)
- Python: [`trafficwar`](packages/python)

These packages target trusted backend processes. They call
`https://ingest.trafficwar.tech/v1/server/*`, never the browser/CORS routes.

## Node.js

```bash
npm install @trafficwar/node
```

```ts
import { TrafficWar } from "@trafficwar/node";

const trafficwar = new TrafficWar({
  apiKey: process.env.TRAFFICWAR_API_KEY!,
});

await trafficwar.capture({
  event: "checkout.completed",
  distinct_id: "customer_123",
  latency_ms: 184.2,
  status_code: 200,
  properties: { order_id: "order_456" },
});
```

## Python

```bash
python -m pip install trafficwar
```

```python
import os

from trafficwar import TrafficWar

with TrafficWar(api_key=os.environ["TRAFFICWAR_API_KEY"]) as trafficwar:
    trafficwar.capture(
        {
            "event": "checkout.completed",
            "distinct_id": "customer_123",
            "latency_ms": 184.2,
            "status_code": 200,
            "properties": {"order_id": "order_456"},
        }
    )
```

Both SDKs also provide a batch method for up to 10,000 events. Python includes
synchronous and asynchronous clients.

## Delivery semantics

A successful call returns only after TrafficWar's hot store accepts the
containing insert. Every SDK request carries a fresh `Idempotency-Key`, and the
same serialized body and key are reused for bounded retries. This makes
ambiguous timeout retries safe during the server's receipt window.

Pass a stable UUID as `event_id` when you need event identity beyond that
window. The service derives the account and service from the API key; do not
put credentials, `user_id`, or service identifiers in event payloads.

## Framework examples

Every example performs a real parameterized SQLite lookup and then sends an
event through the local SDK package:

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
