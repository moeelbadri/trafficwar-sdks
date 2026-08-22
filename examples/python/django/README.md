# TrafficWar + Django

A minimal Django 5.2 application that reads a greeting from SQLite, enqueues a
`hello.request` event with the synchronous TrafficWar SDK, and responds without
waiting for delivery. Both successful lookups and `404` responses are
captured.

The initial migration creates the `Greeting` table and seeds:

```text
Ada -> Hello, Ada!
```

## Run locally

Install [uv](https://docs.astral.sh/uv/), then run:

```bash
uv sync --group dev
uv run python manage.py migrate

# Use credentials for a local development ingest service only.
export TRAFFICWAR_API_KEY="replace-with-a-development-key"
export TRAFFICWAR_BASE_URL="http://127.0.0.1:47317"

uv run python manage.py runserver
```

In another terminal:

```bash
curl http://127.0.0.1:8000/hello/Ada/
curl -i http://127.0.0.1:8000/hello/Grace/
```

`Greeting.objects.filter(name=name)` keeps the SQLite lookup parameterized.
The app reuses one lazily-created TrafficWar client per process and closes only
that app-owned client. Django has no general async application-shutdown hook,
so the synchronous client is registered with `atexit`; `close()` blocks while
it flushes the queue before releasing its HTTP resources. Tests inject a
caller-owned SDK client through `override_trafficwar_client()`.

## Test

```bash
uv run pytest
```

The integration tests use Django's real test database and test client. The
actual local `TrafficWar` SDK sends through `httpx.MockTransport`, so tests
make no network calls and never contact a production endpoint. Each test
explicitly calls `flush()` before assertions, checks the bare
`/v1/server/batch` array and generated UUIDv7 `event_id`, then closes both the
SDK and injected HTTP client.
