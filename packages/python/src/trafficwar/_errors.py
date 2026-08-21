from collections.abc import Mapping
from typing import Any, Optional, Union

Number = Union[int, float]


class TrafficWarError(Exception):
    """Base class for every error raised by the TrafficWar SDK."""

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        details: Optional[Mapping[str, Any]] = None,
        retry_after: Optional[float] = None,
        ingest_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.details: dict[str, Any] = dict(details or {})
        detail_status = self.details.get("status")
        self.status = detail_status if isinstance(detail_status, str) else None
        self.retry_after = retry_after
        detail_ingest_id = self.details.get("ingest_id")
        self.ingest_id = (
            ingest_id
            if ingest_id is not None
            else detail_ingest_id
            if isinstance(detail_ingest_id, str)
            else None
        )
        self.idempotency_key = idempotency_key


class ValidationError(TrafficWarError, ValueError):
    """The API key, client options, idempotency key, or event is invalid."""


class SerializationError(ValidationError):
    """An event cannot be represented as valid JSON."""


class TransportError(TrafficWarError):
    """All transport attempts failed before a valid HTTP response arrived."""


class APIError(TrafficWarError):
    """The TrafficWar ingestion API returned an error response."""


class AuthenticationError(APIError):
    """The API key was rejected."""


class ConflictError(APIError):
    """An idempotency key was reused with a different path or body."""


class ServerError(APIError):
    """The server still failed after all configured retries."""


class ResponseError(APIError):
    """The server returned a malformed success response."""


class RateLimitError(APIError):
    """The service's event quota cannot fit the submitted request."""

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        details: Optional[Mapping[str, Any]] = None,
        retry_after: Optional[float] = None,
        ingest_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> None:
        super().__init__(
            message,
            status_code=status_code,
            details=details,
            retry_after=retry_after,
            ingest_id=ingest_id,
            idempotency_key=idempotency_key,
        )
        self.period = self._string("period")
        self.used = self._integer("used")
        self.limit = self._integer("limit")
        self.remaining_events = self._integer("remaining_events")
        self.batch_events = self._integer("batch_events")
        self.retry_after_secs = self._number("retry_after_secs")

    def _string(self, key: str) -> Optional[str]:
        value = self.details.get(key)
        return value if isinstance(value, str) else None

    def _integer(self, key: str) -> Optional[int]:
        value = self.details.get(key)
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def _number(self, key: str) -> Optional[Number]:
        value = self.details.get(key)
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None
