from time import perf_counter

from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET
from trafficwar import Event

from .models import Greeting
from .telemetry import get_trafficwar_client


@require_GET
def hello(_request: HttpRequest, name: str) -> JsonResponse:
    started = perf_counter()
    message = (
        Greeting.objects.filter(name=name).values_list("message", flat=True).first()
    )
    latency_ms = (perf_counter() - started) * 1_000
    found = message is not None
    status_code = 200 if found else 404

    event: Event = {
        "event": "hello.request",
        "distinct_id": name,
        "path": "/hello/{name}/",
        "label": "greeting.lookup",
        "source": "django",
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
    get_trafficwar_client().capture(event)

    if message is None:
        return JsonResponse({"detail": f"No greeting for {name}"}, status=404)
    return JsonResponse({"message": message})
