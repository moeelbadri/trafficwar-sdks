export interface TrafficWarErrorContext {
  status?: number | undefined;
  details?: unknown;
  retryAfterSeconds?: number | undefined;
  ingestId?: string | undefined;
  idempotencyKey?: string | undefined;
  cause?: unknown;
}

export class TrafficWarError extends Error {
  readonly status: number | undefined;
  readonly details: unknown;
  readonly retryAfterSeconds: number | undefined;
  readonly ingestId: string | undefined;
  readonly idempotencyKey: string | undefined;

  constructor(message: string, context: TrafficWarErrorContext = {}) {
    super(
      message,
      context.cause === undefined ? undefined : { cause: context.cause },
    );
    this.name = "TrafficWarError";
    this.status = context.status;
    this.details = context.details;
    this.retryAfterSeconds = context.retryAfterSeconds;
    this.ingestId = context.ingestId;
    this.idempotencyKey = context.idempotencyKey;
  }
}

export interface TrafficWarValidationErrorContext
  extends TrafficWarErrorContext {
  path?: string | undefined;
}

export class TrafficWarValidationError extends TrafficWarError {
  readonly path: string | undefined;

  constructor(
    message: string,
    context: TrafficWarValidationErrorContext = {},
  ) {
    super(message, context);
    this.name = "TrafficWarValidationError";
    this.path = context.path;
  }
}

export interface TrafficWarApiErrorContext extends TrafficWarErrorContext {
  status: number;
}

export class TrafficWarApiError extends TrafficWarError {
  constructor(message: string, context: TrafficWarApiErrorContext) {
    super(message, context);
    this.name = "TrafficWarApiError";
  }
}

export interface TrafficWarRateLimitErrorContext
  extends TrafficWarApiErrorContext {
  period?: string | undefined;
  used?: number | undefined;
  limit?: number | undefined;
  remainingEvents?: number | undefined;
  batchEvents?: number | undefined;
  retryAfterSecs?: number | undefined;
}

export class TrafficWarRateLimitError extends TrafficWarApiError {
  readonly period: string | undefined;
  readonly used: number | undefined;
  readonly limit: number | undefined;
  readonly remainingEvents: number | undefined;
  readonly batchEvents: number | undefined;
  readonly retryAfterSecs: number | undefined;

  constructor(message: string, context: TrafficWarRateLimitErrorContext) {
    super(message, context);
    this.name = "TrafficWarRateLimitError";
    this.period = context.period;
    this.used = context.used;
    this.limit = context.limit;
    this.remainingEvents = context.remainingEvents;
    this.batchEvents = context.batchEvents;
    this.retryAfterSecs = context.retryAfterSecs;
  }
}

export interface TrafficWarConnectionErrorContext
  extends TrafficWarErrorContext {
  attempts: number;
  timedOut?: boolean | undefined;
  aborted?: boolean | undefined;
}

export class TrafficWarConnectionError extends TrafficWarError {
  readonly attempts: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(message: string, context: TrafficWarConnectionErrorContext) {
    super(message, context);
    this.name = "TrafficWarConnectionError";
    this.attempts = context.attempts;
    this.timedOut = context.timedOut ?? false;
    this.aborted = context.aborted ?? false;
  }
}

export interface TrafficWarProtocolErrorContext
  extends TrafficWarErrorContext {
  responseBody?: string | undefined;
}

export class TrafficWarProtocolError extends TrafficWarError {
  readonly responseBody: string | undefined;

  constructor(message: string, context: TrafficWarProtocolErrorContext = {}) {
    super(message, context);
    this.name = "TrafficWarProtocolError";
    this.responseBody = context.responseBody;
  }
}
