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

type OpenString<T extends string> =
  | T
  | (string & Record<never, never>);

export type EventCategory = OpenString<
  "http" | "database" | "redis" | "s3"
>;

export type OperationType = OpenString<
  | "route.handler"
  | "http.request"
  | "postgres.select"
  | "postgres.insert"
  | "postgres.update"
  | "postgres.delete"
  | "redis.get"
  | "redis.incr"
  | "s3.get_object"
  | "s3.put_object"
  | "s3.head_object"
>;

export type KnownS3Provider = "aws-s3" | "ovh-s3" | "minio";

/**
 * An S3 provider alias, optionally qualified as `<bucket>.<provider>`.
 * Examples: `ovh-s3`, `assets.ovh-s3`, `receipts.aws-s3`.
 * The dot is reserved as the bucket/provider separator.
 */
export type S3Source = OpenString<
  KnownS3Provider | `${string}.${KnownS3Provider}`
>;

/**
 * One TrafficWar event. Field names intentionally match the ingest wire
 * contract. Account and service identity are always derived from the API key.
 */
export interface TrafficWarEvent {
  event: EventCategory;
  event_id?: string;
  /** RFC3339 string, epoch milliseconds, or Date. Defaults to capture time. */
  timestamp?: string | number | Date;
  latency_ms?: number;
  properties?: JsonValue;
  user_agent?: string;
  label?: string;
  ip?: string;
  /**
   * Stable emitter or dependency alias. For S3, use a provider such as
   * `ovh-s3`, or `<bucket>.<provider>` such as `assets.ovh-s3` when separate
   * bucket stations are useful. Put the S3 action in `operation_type`.
   */
  source?: string;
  country?: string;
  city?: string;
  trace_id?: string;
  distinct_id?: string;
  path?: string;
  /** RFC HTTP token, normalized to uppercase after trimming. */
  http_method?: string;
  error?: string;
  exception?: string;
  error_code?: string;
  span_kind?: SpanKind;
  /** Concrete work performed, such as `route.handler` or `s3.get_object`. */
  operation_type?: OperationType;
  status_code?: number;
}

export type CompressionMode = "auto" | "gzip" | "none";

export type TrafficWarFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type TrafficWarErrorHandler = (
  error: unknown,
) => void | Promise<void>;

export interface TrafficWarQueueOptions {
  /** Delay from the first pending event before an automatic flush. */
  flushIntervalMs?: number;
  /** Maximum number of unacknowledged events held by this client. */
  maxQueueSize?: number;
  /** Receives errors from automatic background flushes. */
  onError?: TrafficWarErrorHandler;
}

export interface TrafficWarOptions extends TrafficWarQueueOptions {
  apiKey: string;
  baseUrl?: string | URL;
  /** Print batch lifecycle diagnostics without event payloads or credentials. */
  debug?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  compression?: CompressionMode;
  compressionThresholdBytes?: number;
  fetch?: TrafficWarFetch;
}

export interface IngestResult {
  status: "ok";
  accepted: number;
  ingestId: string;
  idempotencyKey: string;
}

export interface FlushResult {
  accepted: number;
  batches: readonly IngestResult[];
}
