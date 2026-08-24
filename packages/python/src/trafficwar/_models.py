from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Literal, Optional, TypedDict, Union

JSONPrimitive = Union[str, int, float, bool, None]
JSONValue = Union[JSONPrimitive, list["JSONValue"], dict[str, "JSONValue"]]
Timestamp = Union[str, int, float, datetime]
SpanKind = Literal["server", "client", "producer", "consumer", "internal"]


class _RequiredEvent(TypedDict):
    event: str


class Event(_RequiredEvent, total=False):
    """A TrafficWar event accepted by the server ingestion API.

    For S3 events, ``source`` is a provider alias such as ``ovh-s3``. Use the
    reserved ``<bucket>.<provider>`` form, such as ``assets.ovh-s3``, only when
    separate bucket stations are useful. ``operation_type`` remains the S3
    action, such as ``s3.get_object``.
    """

    event_id: str
    timestamp: Timestamp
    latency_ms: float
    properties: JSONValue
    user_agent: str
    label: str
    ip: str
    source: str
    country: str
    city: str
    trace_id: str
    distinct_id: str
    path: str
    http_method: str
    error: str
    exception: str
    error_code: str
    span_kind: SpanKind
    operation_type: str
    status_code: int


@dataclass(frozen=True)
class IngestResult:
    """The server acknowledgement for a durably accepted ingest call."""

    status: Literal["ok"]
    accepted: int
    ingest_id: str
    idempotency_key: str


@dataclass(frozen=True)
class FlushResult:
    """The aggregate acknowledgement for one queue drain."""

    accepted: int
    batches: tuple[IngestResult, ...]


@dataclass(frozen=True)
class PreparedRequest:
    path: str
    body: bytes
    idempotency_key: str
    content_encoding: Optional[str]
    expected_accepted: int
    events: tuple[dict[str, Any], ...]


EventInput = Union[Mapping[str, Any], Iterable[Mapping[str, Any]]]
ErrorHandler = Callable[[Exception], None]
