export {
  TrafficWar,
  TRAFFICWAR_DEFAULT_BASE_URL,
  TRAFFICWAR_DEFAULT_FLUSH_INTERVAL_MS,
  TRAFFICWAR_DEFAULT_MAX_RETRIES,
  TRAFFICWAR_DEFAULT_MAX_QUEUE_SIZE,
  TRAFFICWAR_DEFAULT_TIMEOUT_MS,
  TRAFFICWAR_MAX_BATCH_SIZE,
  TRAFFICWAR_MAX_COMPRESSED_BODY_BYTES,
  TRAFFICWAR_MAX_DECODED_BODY_BYTES,
} from "./client";

export {
  TrafficWarApiError,
  TrafficWarConnectionError,
  TrafficWarError,
  TrafficWarProtocolError,
  TrafficWarRateLimitError,
  TrafficWarValidationError,
} from "./errors";

export type {
  TrafficWarApiErrorContext,
  TrafficWarConnectionErrorContext,
  TrafficWarErrorContext,
  TrafficWarProtocolErrorContext,
  TrafficWarRateLimitErrorContext,
  TrafficWarValidationErrorContext,
} from "./errors";

export type {
  CompressionMode,
  FlushResult,
  IngestResult,
  JsonPrimitive,
  JsonValue,
  SpanKind,
  TrafficWarEvent,
  TrafficWarErrorHandler,
  TrafficWarFetch,
  TrafficWarOptions,
  TrafficWarQueueOptions,
} from "./types";
