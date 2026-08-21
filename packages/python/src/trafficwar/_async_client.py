from __future__ import annotations

import asyncio
from collections.abc import Iterable
from types import TracebackType
from typing import Optional

import httpx

from ._base import (
    DEFAULT_BASE_URL,
    DEFAULT_COMPRESSION_THRESHOLD,
    MAX_RETRY_AFTER_SECONDS,
    RETRYABLE_STATUS_CODES,
    BaseTrafficWar,
)
from ._errors import TransportError, ValidationError
from ._models import Event, IngestResult, PreparedRequest


class AsyncTrafficWar(BaseTrafficWar):
    """Reusable asynchronous TrafficWar server-ingestion client."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
        max_retries: int = 3,
        compression: str = "auto",
        compression_threshold: int = DEFAULT_COMPRESSION_THRESHOLD,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            max_retries=max_retries,
            compression=compression,
            compression_threshold=compression_threshold,
        )
        if http_client is not None and not isinstance(http_client, httpx.AsyncClient):
            raise ValidationError("http_client must be an httpx.AsyncClient")
        if http_client is not None and http_client.is_closed:
            raise ValidationError("http_client must not already be closed")
        self._client = http_client if http_client is not None else httpx.AsyncClient()
        self._owns_client = http_client is None
        self._closed = False

    async def capture(self, event: Event, *, idempotency_key: Optional[str] = None) -> IngestResult:
        """Durably ingest one event."""

        prepared = await asyncio.to_thread(self._prepare_capture, event, idempotency_key)
        return await self._send(prepared)

    async def capture_batch(
        self,
        events: Iterable[Event],
        *,
        idempotency_key: Optional[str] = None,
    ) -> IngestResult:
        """Durably ingest a non-empty batch of at most 10,000 events."""

        prepared = await asyncio.to_thread(self._prepare_batch, events, idempotency_key)
        return await self._send(prepared)

    async def _send(self, prepared: PreparedRequest) -> IngestResult:
        if self._closed:
            raise RuntimeError("AsyncTrafficWar client is closed")

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

    async def aclose(self) -> None:
        """Close SDK-owned resources; injected clients remain caller-owned."""

        if self._closed:
            return
        self._closed = True
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> AsyncTrafficWar:
        if self._closed:
            raise RuntimeError("AsyncTrafficWar client is closed")
        return self

    async def __aexit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc_value: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        await self.aclose()
