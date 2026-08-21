export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type SpanKind =
  | "server"
  | "client"
  | "producer"
  | "consumer"
  | "internal";

/**
 * One TrafficWar event. Field names intentionally match the ingest wire
 * contract. Account and service identity are always derived from the API key.
 */
export interface TrafficWarEvent {
  event: string;
  event_id?: string;
  timestamp?: string | number | Date;
  latency_ms?: number;
  properties?: JsonValue;
  user_agent?: string;
  label?: string;
  ip?: string;
  source?: string;
  country?: string;
  city?: string;
  trace_id?: string;
  distinct_id?: string;
  path?: string;
  error?: string;
  exception?: string;
  error_code?: string;
  span_kind?: SpanKind;
  operation_type?: string;
  status_code?: number;
}

export type CompressionMode = "auto" | "gzip" | "none";

export type TrafficWarFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface TrafficWarOptions {
  apiKey: string;
  baseUrl?: string | URL;
  timeoutMs?: number;
  maxRetries?: number;
  compression?: CompressionMode;
  compressionThresholdBytes?: number;
  fetch?: TrafficWarFetch;
}

export interface TrafficWarRequestOptions {
  /**
   * A caller-defined key for coordinating retries across process boundaries.
   * It must contain 1-256 visible ASCII characters.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface IngestResult {
  status: "ok";
  accepted: number;
  ingestId: string;
  idempotencyKey: string;
}
