import gzip
import io
import json
import math
import random
import re
import time
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Optional, cast
from urllib.parse import urlsplit

import httpx

from ._errors import (
    APIError,
    AuthenticationError,
    ConflictError,
    RateLimitError,
    ResponseError,
    SerializationError,
    ServerError,
    TrafficWarError,
    ValidationError,
)
from ._models import ErrorHandler, EventInput, IngestResult, PreparedRequest
from ._uuidv7 import uuid7
from ._version import __version__ as SDK_VERSION

DEFAULT_BASE_URL = "https://ingest.trafficwar.tech"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 3
DEFAULT_FLUSH_INTERVAL = 1.0
DEFAULT_MAX_QUEUE_SIZE = 100_000
MAX_BATCH_EVENTS = 10_000
MAX_ENCODED_BODY_BYTES = 2 * 1024 * 1024
MAX_DECODED_BODY_BYTES = 8 * 1024 * 1024
DEFAULT_COMPRESSION_THRESHOLD = 1024
MAX_RETRY_AFTER_SECONDS = 60.0
MAX_RESPONSE_BODY_CHARS = 4096

RETRYABLE_STATUS_CODES = frozenset({408, 425, 500, 502, 503, 504})
STRING_FIELDS = frozenset(
    {
        "event_id",
        "user_agent",
        "label",
        "ip",
        "source",
        "country",
        "city",
        "trace_id",
        "distinct_id",
        "path",
        "error",
        "exception",
        "error_code",
        "operation_type",
    }
)
ALLOWED_FIELDS = STRING_FIELDS | {
    "event",
    "timestamp",
    "latency_ms",
    "properties",
    "span_kind",
    "status_code",
}
SPAN_KINDS = frozenset({"server", "client", "producer", "consumer", "internal"})
RFC3339_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class _PreparedRequestTooLarge(Exception):
    def __init__(self, limit: str) -> None:
        super().__init__(limit)
        self.limit = limit


class BaseTrafficWar:
    """Shared, transport-independent behavior for both public clients."""

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
    ) -> None:
        self.api_key = self._validate_api_key(api_key)
        self.base_url = self._validate_base_url(base_url)
        self.timeout = self._validate_timeout(timeout)
        self.max_retries = self._validate_max_retries(max_retries)
        self.compression = self._validate_compression(compression)
        self.compression_threshold = self._validate_compression_threshold(compression_threshold)
        self.flush_interval = self._validate_flush_interval(flush_interval)
        self.max_queue_size = self._validate_max_queue_size(max_queue_size)
        self._on_error = self._validate_on_error(on_error)

    @staticmethod
    def _validate_api_key(api_key: str) -> str:
        if not isinstance(api_key, str) or not api_key:
            raise ValidationError("api_key must be a non-empty string")
        if any(ord(char) < 0x21 or ord(char) > 0x7E for char in api_key):
            raise ValidationError("api_key must contain only visible ASCII characters")
        return api_key

    @staticmethod
    def _validate_base_url(base_url: str) -> str:
        if not isinstance(base_url, str) or not base_url:
            raise ValidationError("base_url must be a non-empty URL")
        if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in base_url):
            raise ValidationError("base_url must not contain spaces or control characters")
        try:
            parsed = urlsplit(base_url)
            _ = parsed.port
            httpx.URL(base_url)
        except (httpx.InvalidURL, UnicodeError, ValueError) as exc:
            raise ValidationError("base_url is invalid") from exc
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValidationError("base_url must be an absolute HTTP(S) URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValidationError("base_url must not contain credentials")
        if "?" in base_url or "#" in base_url:
            raise ValidationError("base_url must not contain a query or fragment")
        return base_url.rstrip("/")

    @staticmethod
    def _validate_timeout(timeout: float) -> float:
        if not BaseTrafficWar._is_finite_number(timeout) or timeout <= 0:
            raise ValidationError("timeout must be a finite number greater than zero")
        return float(timeout)

    @staticmethod
    def _validate_max_retries(max_retries: int) -> int:
        if isinstance(max_retries, bool) or not isinstance(max_retries, int) or max_retries < 0:
            raise ValidationError("max_retries must be a non-negative integer")
        return max_retries

    @staticmethod
    def _validate_compression(compression: str) -> str:
        if not isinstance(compression, str) or compression not in {"auto", "gzip", "none"}:
            raise ValidationError("compression must be 'auto', 'gzip', or 'none'")
        return compression

    @staticmethod
    def _validate_compression_threshold(compression_threshold: int) -> int:
        if (
            isinstance(compression_threshold, bool)
            or not isinstance(compression_threshold, int)
            or compression_threshold < 0
        ):
            raise ValidationError("compression_threshold must be a non-negative integer")
        return compression_threshold

    @staticmethod
    def _validate_flush_interval(flush_interval: float) -> float:
        if not BaseTrafficWar._is_finite_number(flush_interval) or flush_interval <= 0:
            raise ValidationError("flush_interval must be a finite number greater than zero")
        return float(flush_interval)

    @staticmethod
    def _validate_max_queue_size(max_queue_size: int) -> int:
        if (
            isinstance(max_queue_size, bool)
            or not isinstance(max_queue_size, int)
            or max_queue_size < 1
        ):
            raise ValidationError("max_queue_size must be a positive integer")
        return max_queue_size

    @staticmethod
    def _validate_on_error(on_error: Optional[ErrorHandler]) -> Optional[ErrorHandler]:
        if on_error is not None and not callable(on_error):
            raise ValidationError("on_error must be callable")
        return on_error

    def _normalize_capture_input(
        self,
        event_or_events: EventInput,
        *,
        force_batch: bool = False,
    ) -> tuple[dict[str, Any], ...]:
        is_single = isinstance(event_or_events, Mapping) and not force_batch
        if is_single:
            raw_events: Any = (event_or_events,)
        else:
            if isinstance(event_or_events, (str, bytes, bytearray, Mapping)):
                raise ValidationError("events must be a non-empty iterable of event mappings")
            raw_events = event_or_events

        try:
            iterator = iter(raw_events)
        except TypeError as exc:
            raise ValidationError("events must be a non-empty iterable of event mappings") from exc

        normalized: list[dict[str, Any]] = []
        for index, event in enumerate(iterator):
            if index >= self.max_queue_size:
                raise ValidationError(
                    f"TrafficWar queue cannot exceed {self.max_queue_size} events"
                )
            normalized.append(self._normalize_event(event, index=None if is_single else index))
        if not normalized:
            raise ValidationError("events must contain at least one event")

        seen: set[str] = set()
        for index, event in enumerate(normalized):
            event_id = cast(str, event["event_id"])
            if event_id in seen:
                raise ValidationError(
                    f"events[{index}].event_id duplicates another event_id in this enqueue"
                )
            seen.add(event_id)
        return tuple(normalized)

    def _normalize_event(self, event: Mapping[str, Any], *, index: Optional[int]) -> dict[str, Any]:
        prefix = f"events[{index}]" if index is not None else "event"
        if not isinstance(event, Mapping):
            raise ValidationError(f"{prefix} must be a mapping")
        if not event:
            raise ValidationError(f"{prefix} must not be empty")
        if any(not isinstance(key, str) for key in event):
            raise ValidationError(f"{prefix} field names must be strings")

        unknown = sorted(set(event) - ALLOWED_FIELDS)
        if unknown:
            names = ", ".join(unknown)
            raise ValidationError(f"{prefix} contains unsupported field(s): {names}")

        normalized = dict(event)
        name = normalized.get("event")
        if not isinstance(name, str) or not name.strip():
            raise ValidationError(f"{prefix}.event must be a non-empty string")

        for field in STRING_FIELDS:
            if field in normalized and not isinstance(normalized[field], str):
                raise ValidationError(f"{prefix}.{field} must be a string")

        if "event_id" in normalized:
            event_id = cast(str, normalized["event_id"])
            try:
                parsed_event_id = uuid.UUID(event_id)
            except (AttributeError, ValueError) as exc:
                raise ValidationError(f"{prefix}.event_id must be a UUID string") from exc
            if not UUID_RE.fullmatch(event_id) or str(parsed_event_id).lower() != event_id.lower():
                raise ValidationError(f"{prefix}.event_id must be a UUID string")
        else:
            normalized["event_id"] = uuid7()

        if "latency_ms" in normalized:
            latency = normalized["latency_ms"]
            if not self._is_finite_number(latency):
                raise ValidationError(f"{prefix}.latency_ms must be a finite number")

        if "status_code" in normalized:
            status_code = normalized["status_code"]
            if (
                isinstance(status_code, bool)
                or not isinstance(status_code, int)
                or not 0 <= status_code <= 65_535
            ):
                raise ValidationError(
                    f"{prefix}.status_code must be an integer from 0 through 65535"
                )

        if "span_kind" in normalized:
            span_kind = normalized["span_kind"]
            if not isinstance(span_kind, str) or span_kind not in SPAN_KINDS:
                allowed = ", ".join(sorted(SPAN_KINDS))
                raise ValidationError(f"{prefix}.span_kind must be one of: {allowed}")

        if "timestamp" in normalized:
            normalized["timestamp"] = self._normalize_timestamp(
                normalized["timestamp"], prefix=prefix
            )
        else:
            normalized["timestamp"] = (
                datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
        try:
            serialized = json.dumps(
                normalized,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            snapshot = json.loads(serialized)
        except (TypeError, ValueError, OverflowError, RecursionError) as exc:
            raise SerializationError(f"event data is not JSON serializable: {exc}") from exc
        if not isinstance(snapshot, dict):
            raise SerializationError("event data is not JSON serializable")
        return cast(dict[str, Any], snapshot)

    @staticmethod
    def _normalize_timestamp(value: Any, *, prefix: str) -> Any:
        if isinstance(value, datetime):
            if value.tzinfo is None or value.utcoffset() is None:
                raise ValidationError(f"{prefix}.timestamp datetime must be timezone-aware")
            return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        if isinstance(value, bool):
            raise ValidationError(
                f"{prefix}.timestamp must be RFC3339, epoch milliseconds, or a datetime"
            )
        if isinstance(value, (int, float)):
            if not BaseTrafficWar._is_finite_number(value):
                raise ValidationError(f"{prefix}.timestamp epoch milliseconds must be finite")
            return value
        if isinstance(value, str):
            if not RFC3339_RE.fullmatch(value):
                raise ValidationError(f"{prefix}.timestamp must be an RFC3339 timestamp")
            candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
            try:
                parsed = datetime.fromisoformat(candidate)
            except ValueError as exc:
                raise ValidationError(f"{prefix}.timestamp must be an RFC3339 timestamp") from exc
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValidationError(f"{prefix}.timestamp must include a UTC offset")
            return value
        raise ValidationError(
            f"{prefix}.timestamp must be RFC3339, epoch milliseconds, or a datetime"
        )

    @staticmethod
    def _is_finite_number(value: Any) -> bool:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return False
        try:
            return math.isfinite(value)
        except OverflowError:
            return False

    def _prepare_queued_batch(
        self,
        queued: Sequence[dict[str, Any]],
    ) -> PreparedRequest:
        count = min(len(queued), MAX_BATCH_EVENTS)
        if count == 0:
            raise RuntimeError("TrafficWar queue state is inconsistent")

        while True:
            events = tuple(queued[:count])
            idempotency_key = uuid7()
            try:
                return self._prepare(
                    "/v1/server/batch",
                    list(events),
                    expected_accepted=count,
                    idempotency_key=idempotency_key,
                    events=events,
                )
            except _PreparedRequestTooLarge as exc:
                if count > 1:
                    count = max(1, count // 2)
                    continue
                if exc.limit == "decoded":
                    message = f"decoded JSON body exceeds {MAX_DECODED_BODY_BYTES} bytes"
                else:
                    message = f"HTTP request body exceeds {MAX_ENCODED_BODY_BYTES} bytes"
                raise ValidationError(message, idempotency_key=idempotency_key) from exc

    def _prepare(
        self,
        path: str,
        payload: Any,
        *,
        expected_accepted: int,
        idempotency_key: str,
        events: tuple[dict[str, Any], ...],
    ) -> PreparedRequest:
        try:
            decoded = json.dumps(
                payload,
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        except (TypeError, ValueError, OverflowError, RecursionError) as exc:
            raise SerializationError(f"event data is not JSON serializable: {exc}") from exc

        if len(decoded) > MAX_DECODED_BODY_BYTES:
            raise _PreparedRequestTooLarge("decoded")

        use_gzip = self.compression == "gzip" or (
            self.compression == "auto"
            and (
                len(decoded) >= self.compression_threshold or len(decoded) > MAX_ENCODED_BODY_BYTES
            )
        )
        body = self._gzip(decoded) if use_gzip else decoded
        if len(body) > MAX_ENCODED_BODY_BYTES:
            raise _PreparedRequestTooLarge("wire")
        return PreparedRequest(
            path=path,
            body=body,
            idempotency_key=idempotency_key,
            content_encoding="gzip" if use_gzip else None,
            expected_accepted=expected_accepted,
            events=events,
        )

    @staticmethod
    def _gzip(data: bytes) -> bytes:
        output = io.BytesIO()
        with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as stream:
            stream.write(data)
        return output.getvalue()

    def _url(self, prepared: PreparedRequest) -> str:
        return f"{self.base_url}{prepared.path}"

    def _headers(self, prepared: PreparedRequest) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Idempotency-Key": prepared.idempotency_key,
            "User-Agent": f"trafficwar-python/{SDK_VERSION}",
            "x-trafficwar-sdk": f"python/{SDK_VERSION}",
        }
        if prepared.content_encoding is not None:
            headers["Content-Encoding"] = prepared.content_encoding
        return headers

    def _request(self, prepared: PreparedRequest) -> httpx.Request:
        timeout = {
            "connect": self.timeout,
            "read": self.timeout,
            "write": self.timeout,
            "pool": self.timeout,
        }
        return httpx.Request(
            "POST",
            self._url(prepared),
            headers=self._headers(prepared),
            content=prepared.body,
            extensions={"timeout": timeout},
        )

    @staticmethod
    def _retry_delay(failure_index: int, response: Optional[httpx.Response]) -> float:
        jitter_cap = 0.5 * (2 ** min(failure_index, 4))
        jitter = random.uniform(0.0, jitter_cap)
        if response is None:
            return jitter
        retry_after = BaseTrafficWar._response_retry_after(response)
        return max(jitter, retry_after or 0.0)

    @staticmethod
    def _response_retry_after(response: httpx.Response) -> Optional[float]:
        value = response.headers.get("Retry-After")
        if value:
            try:
                seconds = float(value)
            except ValueError:
                try:
                    target = parsedate_to_datetime(value)
                    if target.tzinfo is None:
                        target = target.replace(tzinfo=timezone.utc)
                    seconds = target.timestamp() - time.time()
                except (TypeError, ValueError, OverflowError):
                    seconds = -1
            if math.isfinite(seconds) and seconds >= 0:
                return seconds

        try:
            payload = response.json()
        except (ValueError, RecursionError):
            return None
        if isinstance(payload, dict):
            retry_after_value = payload.get("retry_after_secs")
            if isinstance(retry_after_value, (int, float)) and not isinstance(
                retry_after_value, bool
            ):
                try:
                    if math.isfinite(retry_after_value) and retry_after_value >= 0:
                        return float(retry_after_value)
                except OverflowError:
                    pass
        return None

    def _result_or_error(self, response: httpx.Response, prepared: PreparedRequest) -> IngestResult:
        details, is_object = self._response_details(response)
        retry_after = self._response_retry_after(response)

        if 200 <= response.status_code < 300:
            if details.get("status") != "ok":
                raise ResponseError(
                    "TrafficWar returned a malformed success response",
                    status_code=response.status_code,
                    details=details,
                    retry_after=retry_after,
                    idempotency_key=prepared.idempotency_key,
                )
            accepted = details.get("accepted")
            ingest_id = details.get("ingest_id")
            if (
                isinstance(accepted, bool)
                or not isinstance(accepted, int)
                or accepted != prepared.expected_accepted
                or not isinstance(ingest_id, str)
                or not ingest_id
            ):
                raise ResponseError(
                    "TrafficWar returned a malformed success response",
                    status_code=response.status_code,
                    details=details,
                    retry_after=retry_after,
                    idempotency_key=prepared.idempotency_key,
                )
            return IngestResult(
                status="ok",
                accepted=accepted,
                ingest_id=ingest_id,
                idempotency_key=prepared.idempotency_key,
            )

        message_value = details.get("error")
        response_status = details.get("status")
        if (
            not is_object
            or response_status not in {"error", "pending"}
            or not isinstance(message_value, str)
            or not message_value
        ):
            raise ResponseError(
                "TrafficWar returned a malformed error response",
                status_code=response.status_code,
                details=self._raw_response_details(response),
                retry_after=retry_after,
                idempotency_key=prepared.idempotency_key,
            )
        message = message_value
        error_type: type[TrafficWarError]
        if response.status_code == 429:
            error_type = RateLimitError
        elif response.status_code == 409:
            error_type = ConflictError
        elif response.status_code in {401, 403}:
            error_type = AuthenticationError
        elif response.status_code >= 500 or response.status_code in {408, 425}:
            error_type = ServerError
        else:
            error_type = APIError
        raise error_type(
            message,
            status_code=response.status_code,
            details=details,
            retry_after=retry_after,
            idempotency_key=prepared.idempotency_key,
        )

    @staticmethod
    def _response_details(response: httpx.Response) -> tuple[dict[str, Any], bool]:
        try:
            payload = response.json()
        except (ValueError, RecursionError):
            return BaseTrafficWar._raw_response_details(response), False
        if isinstance(payload, dict):
            return payload, True
        return BaseTrafficWar._raw_response_details(response), False

    @staticmethod
    def _raw_response_details(response: httpx.Response) -> dict[str, Any]:
        text = response.text
        return {"body": text[:MAX_RESPONSE_BODY_CHARS]} if text else {}
