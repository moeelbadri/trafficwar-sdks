import { Buffer } from "node:buffer";

import { TrafficWarValidationError } from "./errors";
import type { TrafficWarEvent } from "./types";

export type NormalizedEvent = Record<string, unknown> & { event: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/i;

const STRING_FIELDS = [
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
] as const;

const SPAN_KINDS = new Set([
  "server",
  "client",
  "producer",
  "consumer",
  "internal",
]);

const FORBIDDEN_IDENTITY_FIELDS = ["user_id", "service", "service_id"] as const;

function validationError(
  message: string,
  path: string,
  idempotencyKey: string | undefined,
  cause?: unknown,
): TrafficWarValidationError {
  return new TrafficWarValidationError(message, {
    path,
    idempotencyKey,
    cause,
  });
}

function snapshotJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
  idempotencyKey: string | undefined,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationError(
        `${path} must contain only finite JSON numbers`,
        path,
        idempotencyKey,
      );
    }
    return value;
  }

  if (typeof value !== "object") {
    throw validationError(
      `${path} contains a value that JSON cannot represent`,
      path,
      idempotencyKey,
    );
  }

  if (value instanceof Date) {
    throw validationError(
      `${path} contains a Date; only timestamp accepts Date values`,
      path,
      idempotencyKey,
    );
  }

  if (ancestors.has(value)) {
    throw validationError(
      `${path} contains a circular reference`,
      path,
      idempotencyKey,
    );
  }

  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw validationError(
        `${path} contains a non-JSON object`,
        path,
        idempotencyKey,
      );
    }
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const snapshot: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw validationError(
            `${path}[${index}] is missing; sparse arrays are not valid JSON values`,
            `${path}[${index}]`,
            idempotencyKey,
          );
        }
        snapshot.push(
          snapshotJsonValue(
            value[index],
            `${path}[${index}]`,
            ancestors,
            idempotencyKey,
          ),
        );
      }
      return snapshot;
    }

    const snapshot: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      snapshot[key] = snapshotJsonValue(
        child,
        `${path}.${key}`,
        ancestors,
        idempotencyKey,
      );
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeTimestamp(
  timestamp: unknown,
  path: string,
  idempotencyKey: string | undefined,
): string | number {
  if (timestamp instanceof Date) {
    if (!Number.isFinite(timestamp.getTime())) {
      throw validationError(
        `${path} must be a valid Date`,
        path,
        idempotencyKey,
      );
    }
    return timestamp.toISOString();
  }

  if (typeof timestamp === "number") {
    if (!Number.isSafeInteger(timestamp)) {
      throw validationError(
        `${path} must be an integer epoch-millisecond value`,
        path,
        idempotencyKey,
      );
    }
    return timestamp;
  }

  if (typeof timestamp !== "string") {
    throw validationError(
      `${path} must be an RFC3339 string, epoch-millisecond number, or Date`,
      path,
      idempotencyKey,
    );
  }

  const match = RFC3339_PATTERN.exec(timestamp);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match?.[8] === undefined ? 0 : Number(match[8]);
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (
    match === null ||
    month < 1 ||
    month > 12 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw validationError(
      `${path} must be an RFC3339 string, epoch-millisecond number, or Date`,
      path,
      idempotencyKey,
    );
  }
  return timestamp;
}

export function normalizeEvent(
  input: TrafficWarEvent,
  path: string,
  idempotencyKey?: string,
): NormalizedEvent {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw validationError(
      `${path} must be a non-empty object`,
      path,
      idempotencyKey,
    );
  }

  let entries: [string, unknown][];
  try {
    entries = Object.entries(input);
  } catch (cause) {
    throw validationError(
      `${path} could not be read`,
      path,
      idempotencyKey,
      cause,
    );
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    // JSON.stringify omits undefined object properties. Omitting them here also
    // keeps the normalized clone JSON-only without touching the caller object.
    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  if (
    typeof normalized.event !== "string" ||
    normalized.event.trim().length === 0
  ) {
    throw validationError(
      `${path}.event must be a non-empty string`,
      `${path}.event`,
      idempotencyKey,
    );
  }

  for (const field of FORBIDDEN_IDENTITY_FIELDS) {
    if (Object.hasOwn(normalized, field)) {
      throw validationError(
        `${path}.${field} is derived from the API key and must not be sent`,
        `${path}.${field}`,
        idempotencyKey,
      );
    }
  }

  if (Object.hasOwn(normalized, "event_id")) {
    if (
      typeof normalized.event_id !== "string" ||
      !UUID_PATTERN.test(normalized.event_id)
    ) {
      throw validationError(
        `${path}.event_id must be a UUID string`,
        `${path}.event_id`,
        idempotencyKey,
      );
    }
  }

  if (Object.hasOwn(normalized, "timestamp")) {
    normalized.timestamp = normalizeTimestamp(
      normalized.timestamp,
      `${path}.timestamp`,
      idempotencyKey,
    );
  } else {
    normalized.timestamp = new Date().toISOString();
  }

  if (
    Object.hasOwn(normalized, "latency_ms") &&
    (typeof normalized.latency_ms !== "number" ||
      !Number.isFinite(normalized.latency_ms))
  ) {
    throw validationError(
      `${path}.latency_ms must be a finite number`,
      `${path}.latency_ms`,
      idempotencyKey,
    );
  }

  if (
    Object.hasOwn(normalized, "status_code") &&
    (typeof normalized.status_code !== "number" ||
      !Number.isInteger(normalized.status_code) ||
      normalized.status_code < 0 ||
      normalized.status_code > 65_535)
  ) {
    throw validationError(
      `${path}.status_code must be an integer from 0 to 65535`,
      `${path}.status_code`,
      idempotencyKey,
    );
  }

  for (const field of STRING_FIELDS) {
    if (
      Object.hasOwn(normalized, field) &&
      typeof normalized[field] !== "string"
    ) {
      throw validationError(
        `${path}.${field} must be a string`,
        `${path}.${field}`,
        idempotencyKey,
      );
    }
  }

  if (
    Object.hasOwn(normalized, "span_kind") &&
    (typeof normalized.span_kind !== "string" ||
      !SPAN_KINDS.has(normalized.span_kind))
  ) {
    throw validationError(
      `${path}.span_kind must be server, client, producer, consumer, or internal`,
      `${path}.span_kind`,
      idempotencyKey,
    );
  }

  try {
    return snapshotJsonValue(
      normalized,
      path,
      new WeakSet(),
      idempotencyKey,
    ) as NormalizedEvent;
  } catch (error) {
    if (error instanceof TrafficWarValidationError) {
      throw error;
    }
    throw validationError(
      `${path} is not JSON-serializable`,
      path,
      idempotencyKey,
      error,
    );
  }
}

export function serializeJson(
  payload: unknown,
  idempotencyKey: string,
): Buffer {
  let serialized: string;
  try {
    const value = JSON.stringify(payload);
    if (value === undefined) {
      throw new TypeError("JSON.stringify returned undefined");
    }
    serialized = value;
  } catch (cause) {
    throw validationError(
      "Request body is not JSON-serializable",
      "body",
      idempotencyKey,
      cause,
    );
  }
  return Buffer.from(serialized, "utf8");
}
