from __future__ import annotations

import threading
import time
import warnings
from collections import deque
from contextlib import suppress
from dataclasses import dataclass
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


@dataclass
class _DrainCycle:
    done: bool = False
    result: Optional[FlushResult] = None
    error: Optional[Exception] = None


@dataclass
class _CloseCycle:
    done: bool = False
    result: Optional[FlushResult] = None
    error: Optional[Exception] = None


def _empty_flush_result() -> FlushResult:
    return FlushResult(accepted=0, batches=())


class TrafficWar(BaseTrafficWar):
    """Thread-safe synchronous client with automatic background batching."""

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
        http_client: Optional[httpx.Client] = None,
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
        if http_client is not None and not isinstance(http_client, httpx.Client):
            raise ValidationError("http_client must be an httpx.Client")
        if http_client is not None and http_client.is_closed:
            raise ValidationError("http_client must not already be closed")
        self._client = http_client if http_client is not None else httpx.Client()
        self._owns_client = http_client is None

        self._condition = threading.Condition()
        self._queue: deque[dict[str, Any]] = deque()
        self._pending_event_ids: set[str] = set()
        self._pending_count = 0
        self._prepared: Optional[PreparedRequest] = None
        self._deadline: Optional[float] = None
        self._immediate = False
        self._drain_cycle: Optional[_DrainCycle] = None
        self._close_cycle: Optional[_CloseCycle] = None
        self._closing = False
        self._closed = False
        self._worker_stop = False
        self._worker = self._new_worker()
        self._worker.start()

    def capture(self, event_or_events: EventInput) -> None:
        """Validate, snapshot, and enqueue one event or a non-empty iterable."""

        self._enqueue(event_or_events, force_batch=False)

    def capture_batch(
        self,
        events: EventInput,
    ) -> None:
        """Deprecated compatibility alias for ``capture(events)``."""

        warnings.warn(
            "capture_batch() is deprecated; pass the iterable directly to capture()",
            DeprecationWarning,
            stacklevel=2,
        )
        self._enqueue(events, force_batch=True)

    def _enqueue(self, event_or_events: EventInput, *, force_batch: bool) -> None:
        normalized = self._normalize_capture_input(event_or_events, force_batch=force_batch)
        with self._condition:
            if self._closed:
                raise RuntimeError("TrafficWar client is closed")
            if self._closing:
                raise RuntimeError("TrafficWar client is closing")
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
            elif was_empty and self._drain_cycle is None:
                self._deadline = time.monotonic() + self.flush_interval
            self._condition.notify_all()

    def flush(self) -> FlushResult:
        """Drain all queued and in-flight events, surfacing delivery failures."""

        with self._condition:
            if self._closed:
                return _empty_flush_result()
            close_cycle = self._close_cycle if self._closing else None
            if close_cycle is None:
                self._deadline = None
                self._immediate = False
                cycle, leader = self._begin_drain_locked()
                self._condition.notify_all()
            else:
                cycle = None
                leader = False

        if close_cycle is not None:
            return self._wait_close_cycle(close_cycle)
        if cycle is None:
            raise RuntimeError("TrafficWar drain state is inconsistent")
        return self._run_or_wait_drain(cycle, leader)

    def _new_worker(self) -> threading.Thread:
        return threading.Thread(
            target=self._worker_loop,
            name="trafficwar-flush",
            daemon=True,
        )

    def _worker_loop(self) -> None:
        while True:
            with self._condition:
                while True:
                    if self._worker_stop:
                        return
                    if self._pending_count == 0:
                        self._deadline = None
                        self._immediate = False
                        self._condition.wait()
                        continue
                    if self._drain_cycle is not None:
                        cycle = self._drain_cycle
                        leader = False
                        break

                    now = time.monotonic()
                    if self._immediate or (self._deadline is not None and now >= self._deadline):
                        self._deadline = None
                        self._immediate = False
                        cycle, leader = self._begin_drain_locked()
                        break
                    if self._deadline is None:
                        self._deadline = now + self.flush_interval
                    remaining = max(0.0, self._deadline - now)
                    self._condition.wait(timeout=min(remaining, 86_400.0))

            try:
                self._run_or_wait_drain(cycle, leader)
            except Exception as error:
                if leader:
                    self._report_background_error(error)

    def _begin_drain_locked(self) -> tuple[_DrainCycle, bool]:
        if self._drain_cycle is not None:
            return self._drain_cycle, False
        cycle = _DrainCycle()
        self._drain_cycle = cycle
        self._deadline = None
        self._immediate = False
        return cycle, True

    def _run_or_wait_drain(self, cycle: _DrainCycle, leader: bool) -> FlushResult:
        if not leader:
            with self._condition:
                while not cycle.done:
                    self._condition.wait()
                if cycle.error is not None:
                    raise cycle.error
                if cycle.result is None:
                    raise RuntimeError("TrafficWar drain completed without a result")
                return cycle.result

        try:
            result = self._drain()
        except Exception as error:
            self._finish_drain(cycle, error=error)
            raise
        self._finish_drain(cycle, result=result)
        return result

    def _finish_drain(
        self,
        cycle: _DrainCycle,
        *,
        result: Optional[FlushResult] = None,
        error: Optional[Exception] = None,
    ) -> None:
        with self._condition:
            cycle.result = result
            cycle.error = error
            cycle.done = True
            if self._drain_cycle is cycle:
                self._drain_cycle = None
            self._immediate = error is None and self._pending_count >= MAX_BATCH_EVENTS
            if self._pending_count == 0 or self._immediate:
                self._deadline = None
            elif not self._closed and not self._closing and not self._worker_stop:
                self._deadline = time.monotonic() + self.flush_interval
            self._condition.notify_all()

    def _drain(self) -> FlushResult:
        accepted = 0
        batches: list[IngestResult] = []

        while True:
            with self._condition:
                if self._pending_count == 0:
                    return FlushResult(accepted=accepted, batches=tuple(batches))
                prepared = self._prepared

            if prepared is None:
                prepared = self._prepare_next_batch()

            result = self._send(prepared)
            with self._condition:
                if self._prepared is not prepared:
                    raise RuntimeError("TrafficWar prepared batch state is inconsistent")
                self._prepared = None
                self._pending_count -= len(prepared.events)
                for event in prepared.events:
                    self._pending_event_ids.remove(event["event_id"])
                self._condition.notify_all()
            accepted += result.accepted
            batches.append(result)

    def _prepare_next_batch(self) -> PreparedRequest:
        with self._condition:
            if self._prepared is not None:
                return self._prepared
            queued = list(islice(self._queue, 0, MAX_BATCH_EVENTS))

        prepared = self._prepare_queued_batch(queued)
        with self._condition:
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

    def _send(self, prepared: PreparedRequest) -> IngestResult:
        for attempt in range(self.max_retries + 1):
            request = self._request(prepared)
            try:
                response = self._client.send(
                    request,
                    auth=None,
                    follow_redirects=False,
                )
            except httpx.TransportError as exc:
                if attempt < self.max_retries:
                    time.sleep(self._retry_delay(attempt, None))
                    continue
                raise TransportError(
                    f"TrafficWar transport failed after {attempt + 1} attempt(s): {exc}",
                    details={"exception": type(exc).__name__},
                    idempotency_key=prepared.idempotency_key,
                ) from exc

            if response.status_code in RETRYABLE_STATUS_CODES and attempt < self.max_retries:
                delay = self._retry_delay(attempt, response)
                if delay <= MAX_RETRY_AFTER_SECONDS:
                    response.close()
                    time.sleep(delay)
                    continue
            try:
                return self._result_or_error(response, prepared)
            finally:
                response.close()

        raise AssertionError("retry loop exited unexpectedly")

    def close(self) -> FlushResult:
        """Stop automatic work, drain successfully, then close owned resources."""

        with self._condition:
            if self._closed:
                return _empty_flush_result()
            if self._closing:
                close_cycle = self._close_cycle
                leader = False
                active = None
                worker = self._worker
            else:
                close_cycle = _CloseCycle()
                self._close_cycle = close_cycle
                self._closing = True
                self._worker_stop = True
                self._deadline = None
                self._immediate = False
                active = self._drain_cycle
                worker = self._worker
                leader = True
                self._condition.notify_all()

        if close_cycle is None:
            raise RuntimeError("TrafficWar close state is inconsistent")
        if not leader:
            return self._wait_close_cycle(close_cycle)

        accepted = 0
        batches: list[IngestResult] = []
        try:
            if active is not None:
                result = self._run_or_wait_drain(active, False)
                accepted += result.accepted
                batches.extend(result.batches)
            if worker is not threading.current_thread():
                worker.join()

            while True:
                with self._condition:
                    if self._pending_count == 0:
                        break
                    cycle, drain_leader = self._begin_drain_locked()
                result = self._run_or_wait_drain(cycle, drain_leader)
                accepted += result.accepted
                batches.extend(result.batches)

            if self._owns_client:
                self._client.close()
            result = FlushResult(accepted=accepted, batches=tuple(batches))
        except Exception as error:
            if worker is not threading.current_thread() and worker.is_alive():
                worker.join()
            with self._condition:
                self._closing = False
                self._worker_stop = False
                if self._pending_count > 0:
                    self._deadline = time.monotonic() + self.flush_interval
                if worker is not threading.current_thread():
                    self._worker = self._new_worker()
                    self._worker.start()
                close_cycle.error = error
                close_cycle.done = True
                self._close_cycle = None
                self._condition.notify_all()
            raise

        with self._condition:
            self._closed = True
            self._closing = False
            close_cycle.result = result
            close_cycle.done = True
            self._close_cycle = None
            self._condition.notify_all()
        return result

    def _wait_close_cycle(self, cycle: _CloseCycle) -> FlushResult:
        with self._condition:
            while not cycle.done:
                self._condition.wait()
            if cycle.error is not None:
                raise cycle.error
            if cycle.result is None:
                raise RuntimeError("TrafficWar close completed without a result")
            return cycle.result

    def __enter__(self) -> TrafficWar:
        with self._condition:
            if self._closed:
                raise RuntimeError("TrafficWar client is closed")
            if self._closing:
                raise RuntimeError("TrafficWar client is closing")
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        self.close()
