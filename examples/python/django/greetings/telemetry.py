from __future__ import annotations

import atexit
import logging
from collections.abc import Iterator
from contextlib import contextmanager
from threading import RLock

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from trafficwar import TrafficWar

_lock = RLock()
_client: TrafficWar | None = None
_owns_client = False
_logger = logging.getLogger(__name__)


def _report_background_error(error: Exception) -> None:
    _logger.error("TrafficWar automatic flush failed: %s", error)


def get_trafficwar_client() -> TrafficWar:
    """Return the process-wide SDK client, creating the app-owned client lazily."""

    global _client, _owns_client
    with _lock:
        if _client is None:
            if not settings.TRAFFICWAR_API_KEY:
                raise ImproperlyConfigured("TRAFFICWAR_API_KEY must be set")
            _client = TrafficWar(
                api_key=settings.TRAFFICWAR_API_KEY,
                base_url=settings.TRAFFICWAR_BASE_URL,
                timeout=settings.TRAFFICWAR_TIMEOUT,
                max_retries=settings.TRAFFICWAR_MAX_RETRIES,
                compression="auto",
                on_error=_report_background_error,
            )
            _owns_client = True
        return _client


@contextmanager
def override_trafficwar_client(client: TrafficWar) -> Iterator[None]:
    """Temporarily inject a caller-owned SDK client without closing it."""

    global _client, _owns_client
    with _lock:
        previous = (_client, _owns_client)
        _client = client
        _owns_client = False
    try:
        yield
    finally:
        with _lock:
            if _client is not client:
                raise RuntimeError("TrafficWar client changed during an override")
            _client, _owns_client = previous


def close_owned_trafficwar_client() -> None:
    """Flush and close the app-owned client; leave injected clients caller-owned."""

    global _client, _owns_client
    with _lock:
        if _client is None or not _owns_client:
            return
        client = _client
    client.close()
    with _lock:
        if _client is client and _owns_client:
            _client = None
            _owns_client = False


atexit.register(close_owned_trafficwar_client)
