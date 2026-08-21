# TrafficWar + FastAPI

A compact FastAPI application that reads a greeting from SQLite and awaits a
durable `hello.request` capture through `AsyncTrafficWar`. The app captures both
successful lookups and `404` responses.

`create_app()` owns a seeded in-memory SQLite connection and, unless one is
injected, an async TrafficWar client. SQLite work runs in an AnyIO worker thread;
the shared connection uses `check_same_thread=False` plus a lock.

## Run locally

Install [uv](https://docs.astral.sh/uv/), then run:

```bash
uv sync --group dev

# Use credentials for a local development ingest service only.
export TRAFFICWAR_API_KEY="replace-with-a-development-key"
export TRAFFICWAR_BASE_URL="http://127.0.0.1:47317"

uv run uvicorn app.main:app --reload
```

In another terminal:

```bash
curl http://127.0.0.1:8000/hello/Ada
curl -i http://127.0.0.1:8000/hello/Grace
```

The default database is in memory and is seeded with `Ada -> Hello, Ada!` during
the application lifespan. Set `GREETING_DB_PATH=./greetings.db` to use a
persistent SQLite file. The query uses a SQLite `?` parameter rather than
interpolating the path value.

## Test

```bash
uv run pytest
```

The integration tests drive the ASGI app through `httpx.ASGITransport`, run its
lifespan with `asgi-lifespan`, and inject the actual local `AsyncTrafficWar` SDK
backed by `httpx.MockTransport`. They make no network calls and verify that
caller-owned clients remain open after app shutdown.
