from __future__ import annotations

import logging
import os
import sqlite3
from contextlib import asynccontextmanager
from threading import Lock
from time import perf_counter
from typing import Annotated

import anyio
from fastapi import Depends, FastAPI, HTTPException, Request
from trafficwar import AsyncTrafficWar, Event

logger = logging.getLogger(__name__)


def _report_background_error(error: Exception) -> None:
    logger.error("TrafficWar automatic flush failed: %s", error)


class GreetingStore:
    """A single SQLite connection protected for use from worker threads."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self._lock = Lock()

    @classmethod
    def open(cls, database_path: str) -> GreetingStore:
        connection = sqlite3.connect(
            database_path,
            check_same_thread=False,
            timeout=5,
        )
        try:
            with connection:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS greetings (
                        name TEXT PRIMARY KEY,
                        message TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    INSERT INTO greetings (name, message)
                    VALUES (?, ?)
                    ON CONFLICT(name) DO UPDATE SET message = excluded.message
                    """,
                    ("Ada", "Hello, Ada!"),
                )
        except BaseException:
            connection.close()
            raise
        return cls(connection)

    def lookup(self, name: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT message FROM greetings WHERE name = ?",
                (name,),
            ).fetchone()
        return None if row is None else str(row[0])

    def close(self) -> None:
        with self._lock:
            self._connection.close()


def get_greeting_store(request: Request) -> GreetingStore:
    return request.app.state.greeting_store


def get_trafficwar(request: Request) -> AsyncTrafficWar:
    return request.app.state.trafficwar


GreetingStoreDep = Annotated[GreetingStore, Depends(get_greeting_store)]
TrafficWarDep = Annotated[AsyncTrafficWar, Depends(get_trafficwar)]


def _new_trafficwar_client() -> AsyncTrafficWar:
    api_key = os.environ.get("TRAFFICWAR_API_KEY", "")
    if not api_key:
        raise RuntimeError("TRAFFICWAR_API_KEY must be set")
    return AsyncTrafficWar(
        api_key=api_key,
        base_url=os.environ.get(
            "TRAFFICWAR_BASE_URL",
            "http://127.0.0.1:47317",
        ),
        timeout=float(os.environ.get("TRAFFICWAR_TIMEOUT", "5")),
        max_retries=int(os.environ.get("TRAFFICWAR_MAX_RETRIES", "2")),
        compression="auto",
        on_error=_report_background_error,
    )


def create_app(
    *,
    trafficwar: AsyncTrafficWar | None = None,
    database_path: str = ":memory:",
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        store = await anyio.to_thread.run_sync(GreetingStore.open, database_path)
        sdk = trafficwar
        owns_sdk = False
        try:
            if sdk is None:
                sdk = _new_trafficwar_client()
                owns_sdk = True
            application.state.greeting_store = store
            application.state.trafficwar = sdk
            yield
        finally:
            try:
                if owns_sdk and sdk is not None:
                    await sdk.aclose()
            finally:
                await anyio.to_thread.run_sync(store.close)
                application.state.greeting_store = None
                application.state.trafficwar = None

    application = FastAPI(
        title="TrafficWar FastAPI example",
        lifespan=lifespan,
    )

    @application.get("/hello/{name}")
    async def hello(
        name: str,
        store: GreetingStoreDep,
        telemetry: TrafficWarDep,
    ) -> dict[str, str]:
        started = perf_counter()
        message = await anyio.to_thread.run_sync(store.lookup, name)
        latency_ms = (perf_counter() - started) * 1_000
        found = message is not None
        status_code = 200 if found else 404

        event: Event = {
            "event": "hello.request",
            "distinct_id": name,
            "path": "/hello/{name}",
            "label": "greeting.lookup",
            "source": "fastapi",
            "span_kind": "server",
            "operation_type": "sqlite.select",
            "status_code": status_code,
            "latency_ms": latency_ms,
            "properties": {
                "database": "sqlite",
                "found": found,
                "query_latency_ms": latency_ms,
            },
        }
        if not found:
            event["error"] = "greeting_not_found"
        await telemetry.capture(event)

        if message is None:
            raise HTTPException(status_code=404, detail=f"No greeting for {name}")
        return {"message": message}

    return application


app = create_app(database_path=os.environ.get("GREETING_DB_PATH", ":memory:"))
