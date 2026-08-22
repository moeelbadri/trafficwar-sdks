from __future__ import annotations

import asyncio
import warnings
from collections import deque
from contextlib import suppress
from itertools import islice
from types import TracebackType
from typing import Any, Optional

import httpx

from ._base import (
    DEFAULT_BASE_URL,
    DEFAULT_COMPRESSION_THRESHOLD,
    DEFAULT_FLUSH_INTERVAL,
    DEFAULT_MAX_QUEUE_SIZE,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT,
    MAX_BATCH_EVENTS,
    MAX_RETRY_AFTER_SECONDS,
    RETRYABLE_STATUS_CODES,
    BaseTrafficWar,
)
from ._errors import TransportError, ValidationError
from ._models import ErrorHandler, EventInput, FlushResult, IngestResult, PreparedRequest


def _empty_flush_result() -> FlushResult:
    return FlushResult(accepted=0, batches=())


class AsyncTrafficWar(BaseTrafficWar):
    """Async client with a lazily started automatic batching task."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        compression: str = "auto",
        compression_threshold: int = DEFAULT_COMPRESSION_THRESHOLD,
        flush_interval: float = DEFAULT_FLUSH_INTERVAL,
        max_queue_size: int = DEFAULT_MAX_QUEUE_SIZE,
        on_error: Optional[ErrorHandler] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            compression=compression,
            compression_threshold=compression_threshold,
            flush_interval=flush_interval,
            max_queue_size=max_queue_size,
            on_error=on_error,
        )
        if http_client is not None and not isinstance(http_client, httpx.AsyncClient):
            raise ValidationError("http_client must be an httpx.AsyncClient")
        if http_client is not None and http_client.is_closed:
            raise ValidationError("http_client must not already be closed")
        self._client = http_client if http_client is not None else httpx.AsyncClient()
        self._owns_client = http_client is None

        self._queue: deque[dict[str, Any]] = deque()
        self._pending_event_ids: set[str] = set()
        self._pending_count = 0
        self._prepared: Optional[PreparedRequest] = None
        self._deadline: Optional[float] = None
        self._immediate = False
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock: Optional[asyncio.Lock] = None
        self._wake: Optional[asyncio.Event] = None
        self._worker_task: Optional[asyncio.Task[None]] = None
        self._drain_task: Optional[asyncio.Task[FlushResult]] = None
        self._close_task: Optional[asyncio.Task[FlushResult]] = None
        self._worker_stop = False
        self._closing = False
        self._closed = False

    async def capture(self, event_or_events: EventInput) -> None:
        """Validate, snapshot, and enqueue one event or a non-empty iterable."""

        await self._enqueue(event_or_events, force_batch=False)

    async def capture_batch(
        self,
        events: EventInput,
    ) -> None:
        """Deprecated compatibility alias for ``capture(events)``."""

        warnings.warn(
            "capture_batch() is deprecated; pass the iterable directly to capture()",
            DeprecationWarning,
            stacklevel=2,
        )
        await self._enqueue(events, force_batch=True)

    async def _enqueue(self, event_or_events: EventInput, *, force_batch: bool) -> None:
        if self._closed:
            raise RuntimeError("AsyncTrafficWar client is closed")
        _loop, lock, wake = self._ensure_runtime()
        async with lock:
            if self._closed:
                raise RuntimeError("AsyncTrafficWar client is closed")
            if self._closing:
                raise RuntimeError("AsyncTrafficWar client is closing")

        normalized = await asyncio.to_thread(
            self._normalize_capture_input,
            event_or_events,
            force_batch=force_batch,
        )
        async with lock:
            if self._closed:
                raise RuntimeError("AsyncTrafficWar client is closed")
            if self._closing:
                raise RuntimeError("AsyncTrafficWar client is closing")
            if len(normalized) > self.max_queue_size - self._pending_count:
                raise ValidationError(
                    f"TrafficWar queue cannot exceed {self.max_queue_size} events"
                )
            for event in normalized:
                event_id = event["event_id"]
                if event_id in self._pending_event_ids:
                    raise ValidationError(
                        f"event_id {event_id!r} duplicates an unacknowledged event"
                    )

            was_empty = self._pending_count == 0
            self._queue.extend(normalized)
            self._pending_event_ids.update(event["event_id"] for event in normalized)
            self._pending_count += len(normalized)
            if self._pending_count >= MAX_BATCH_EVENTS:
                self._deadline = None
                self._immediate = True
            elif was_empty and self._drain_task is None:
                self._deadline = self._runtime_loop().time() + self.flush_interval
            wake.set()

    def _ensure_runtime(
        self,
    ) -> tuple[asyncio.AbstractEventLoop, asyncio.Lock, asyncio.Event]:
        loop = asyncio.get_running_loop()
        if self._loop is None:
            self._loop = loop
            self._lock = asyncio.Lock()
            self._wake = asyncio.Event()
            self._worker_stop = False
            self._worker_task = loop.create_task(self._worker_loop())
        elif self._loop is not loop:
            raise RuntimeError("AsyncTrafficWar cannot be used across event loops")
        elif (
            not self._closed
            and not self._closing
            and (self._worker_task is None or self._worker_task.done())
        ):
            self._worker_stop = False
            self._worker_task = loop.create_task(self._worker_loop())

        if self._lock is None or self._wake is None:
            raise RuntimeError("AsyncTrafficWar runtime state is inconsistent")
        return loop, self._lock, self._wake

    def _runtime_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            raise RuntimeError("AsyncTrafficWar runtime has not started")
        return self._loop

    def _runtime_lock(self) -> asyncio.Lock:
        if self._lock is None:
            raise RuntimeError("AsyncTrafficWar runtime has not started")
        return self._lock

    def _runtime_wake(self) -> asyncio.Event:
        if self._wake is None:
            raise RuntimeError("AsyncTrafficWar runtime has not started")
        return self._wake

    async def flush(self) -> FlushResult:
        """Drain all queued and in-flight events, surfacing delivery failures."""

        if self._closed:
            return _empty_flush_result()
        _loop, lock, wake = self._ensure_runtime()
        async with lock:
            if self._closed:
                return _empty_flush_result()
            close_task = self._close_task if self._closing else None
            if close_task is None:
                self._deadline = None
                self._immediate = False
                drain_task = self._start_drain_locked()
                wake.set()
            else:
                drain_task = None

        if close_task is not None:
            return await asyncio.shield(close_task)
        if drain_task is None:
            raise RuntimeError("AsyncTrafficWar drain state is inconsistent")
        return await asyncio.shield(drain_task)

    async def _worker_loop(self) -> None:
        loop = self._runtime_loop()
        lock = self._runtime_lock()
        wake = self._runtime_wake()

        while True:
            task: Optional[asyncio.Task[FlushResult]] = None
            observe = False
            delay: Optional[float] = None
            async with lock:
                if self._worker_stop:
                    return
                if self._pending_count == 0:
                    self._deadline = None
                    self._immediate = False
                    wake.clear()
                elif self._drain_task is not None:
                    task = self._drain_task
                    wake.clear()
                else:
                    now = loop.time()
                    if self._immediate or (self._deadline is not None and now >= self._deadline):
                        self._deadline = None
                        self._immediate = False
                        task = self._start_drain_locked()
                        observe = True
                    else:
                        if self._deadline is None:
                            self._deadline = now + self.flush_interval
                        delay = max(0.0, self._deadline - now)
                        wake.clear()

            if task is not None:
                try:
                    await asyncio.shield(task)
                except Exception as error:
                    if observe:
                        self._report_background_error(error)
                continue

            if delay is None:
                await wake.wait()
            else:
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(wake.wait(), timeout=delay)

    def _start_drain_locked(self) -> asyncio.Task[FlushResult]:
        if self._drain_task is not None:
            return self._drain_task
        task = self._runtime_loop().create_task(self._run_drain())
        self._drain_task = task
        return task

    async def _run_drain(self) -> FlushResult:
        accepted = 0
        batches: list[IngestResult] = []
        lock = self._runtime_lock()
        wake = self._runtime_wake()
        current = asyncio.current_task()
        succeeded = False

        try:
            while True:
                async with lock:
                    if self._pending_count == 0:
                        succeeded = True
                        return FlushResult(accepted=accepted, batches=tuple(batches))
                    prepared = self._prepared

                if prepared is None:
                    prepared = await self._prepare_next_batch()

                result = await self._send(prepared)
                async with lock:
                    if self._prepared is not prepared:
                        raise RuntimeError("TrafficWar prepared batch state is inconsistent")
                    self._prepared = None
                    self._pending_count -= len(prepared.events)
                    for event in prepared.events:
                        self._pending_event_ids.remove(event["event_id"])
                accepted += result.accepted
                batches.append(result)
        finally:
            async with lock:
                if self._drain_task is current:
                    self._drain_task = None
                self._immediate = succeeded and self._pending_count >= MAX_BATCH_EVENTS
                if self._pending_count == 0 or self._immediate:
                    self._deadline = None
                elif not self._closed and not self._closing and not self._worker_stop:
                    self._deadline = self._runtime_loop().time() + self.flush_interval
                wake.set()

    async def _prepare_next_batch(self) -> PreparedRequest:
        lock = self._runtime_lock()
        async with lock:
            if self._prepared is not None:
                return self._prepared
            queued = list(islice(self._queue, 0, MAX_BATCH_EVENTS))

        prepared = await asyncio.to_thread(self._prepare_queued_batch, queued)
        async with lock:
            if self._prepared is not None:
                return self._prepared
            for expected in prepared.events:
                actual = self._queue.popleft()
                if actual is not expected:
                    raise RuntimeError("TrafficWar queue order is inconsistent")
            self._prepared = prepared
            return prepared

    def _report_background_error(self, error: Exception) -> None:
        if self._on_error is None:
            return
        with suppress(Exception):
            self._on_error(error)

    async def _send(self, prepared: PreparedRequest) -> IngestResult:
        for attempt in range(self.max_retries + 1):
            request = self._request(prepared)
            try:
                response = await self._client.send(
                    request,
                    auth=None,
                    follow_redirects=False,
                )
            except httpx.TransportError as exc:
                if attempt < self.max_retries:
                    await asyncio.sleep(self._retry_delay(attempt, None))
                    continue
                raise TransportError(
                    f"TrafficWar transport failed after {attempt + 1} attempt(s): {exc}",
                    details={"exception": type(exc).__name__},
                    idempotency_key=prepared.idempotency_key,
                ) from exc

            if response.status_code in RETRYABLE_STATUS_CODES and attempt < self.max_retries:
                delay = self._retry_delay(attempt, response)
                if delay <= MAX_RETRY_AFTER_SECONDS:
                    await response.aclose()
                    await asyncio.sleep(delay)
                    continue
            try:
                return self._result_or_error(response, prepared)
            finally:
                await response.aclose()

        raise AssertionError("retry loop exited unexpectedly")

    async def aclose(self) -> FlushResult:
        """Stop automatic work, drain successfully, then close owned resources."""

        if self._closed:
            return _empty_flush_result()
        loop, lock, wake = self._ensure_runtime()
        async with lock:
            if self._closed:
                return _empty_flush_result()
            if self._close_task is None:
                self._closing = True
                self._worker_stop = True
                self._deadline = None
                self._immediate = False
                wake.set()
                self._close_task = loop.create_task(self._close_impl())
            close_task = self._close_task
        return await asyncio.shield(close_task)

    async def _close_impl(self) -> FlushResult:
        loop = self._runtime_loop()
        lock = self._runtime_lock()
        wake = self._runtime_wake()
        current = asyncio.current_task()
        accepted = 0
        batches: list[IngestResult] = []

        async with lock:
            active = self._drain_task
            worker = self._worker_task

        try:
            if active is not None:
                result = await asyncio.shield(active)
                accepted += result.accepted
                batches.extend(result.batches)
            if worker is not None and worker is not current:
                await worker

            while True:
                async with lock:
                    if self._pending_count == 0:
                        break
                    drain_task = self._start_drain_locked()
                result = await asyncio.shield(drain_task)
                accepted += result.accepted
                batches.extend(result.batches)

            if self._owns_client:
                await self._client.aclose()
            result = FlushResult(accepted=accepted, batches=tuple(batches))
        except Exception:
            if worker is not None and worker is not current and not worker.done():
                await worker
            async with lock:
                self._closing = False
                self._worker_stop = False
                if self._pending_count > 0:
                    self._deadline = loop.time() + self.flush_interval
                if self._worker_task is None or self._worker_task.done():
                    self._worker_task = loop.create_task(self._worker_loop())
                if self._close_task is current:
                    self._close_task = None
                wake.set()
            raise

        async with lock:
            self._closed = True
            self._closing = False
            self._worker_task = None
            if self._close_task is current:
                self._close_task = None
            wake.set()
        return result

    async def __aenter__(self) -> AsyncTrafficWar:
        if self._closed:
            raise RuntimeError("AsyncTrafficWar client is closed")
        if self._closing:
            raise RuntimeError("AsyncTrafficWar client is closing")
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        await self.aclose()
