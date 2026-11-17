from typing import Any

# Explicit measured inputs for transport tests; capture never supplies defaults.
VALID_EVENT: dict[str, Any] = {
    "event": "internal",
    "label": "Test operation",
    "source": "backend-test",
    "operation_type": "test.operation",
    "span_kind": "internal",
    "timestamp": "2026-08-21T12:00:00Z",
    "latency_ms": 0,
}
