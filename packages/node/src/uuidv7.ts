import { randomBytes } from "node:crypto";

const RANDOM_BITS = 74n;
const RANDOM_MASK = (1n << RANDOM_BITS) - 1n;
const MAX_TIMESTAMP = (1n << 48n) - 1n;
const STATE_KEY = Symbol.for("@trafficwar/node.uuidv7-state");

interface UuidV7State {
  lastTimestamp: bigint;
  lastRandom: bigint;
}

const processState = globalThis as unknown as Record<symbol, unknown>;
const existingState = processState[STATE_KEY] as UuidV7State | undefined;
const state: UuidV7State = existingState ?? {
  lastTimestamp: -1n,
  lastRandom: 0n,
};
processState[STATE_KEY] = state;

function random74(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value & RANDOM_MASK;
}

function nextFields(): { timestamp: bigint; random: bigint } {
  const now = BigInt(Date.now());
  if (now < 0n || now > MAX_TIMESTAMP) {
    throw new RangeError("Current time cannot be represented as UUIDv7");
  }

  if (now > state.lastTimestamp) {
    state.lastTimestamp = now;
    state.lastRandom = random74();
  } else if (state.lastRandom < RANDOM_MASK) {
    state.lastRandom += 1n;
  } else {
    if (state.lastTimestamp >= MAX_TIMESTAMP) {
      throw new RangeError("UUIDv7 timestamp space exhausted");
    }
    state.lastTimestamp += 1n;
    state.lastRandom = random74();
  }

  return {
    timestamp: state.lastTimestamp,
    random: state.lastRandom,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Generates an RFC 9562 UUIDv7. Calls are monotonically ordered within this
 * JavaScript process, including when the wall clock stalls or moves backward.
 */
export function uuidv7(): string {
  const { timestamp, random } = nextFields();
  const bytes = new Uint8Array(16);

  let timestampBits = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestampBits & 0xffn);
    timestampBits >>= 8n;
  }

  bytes[6] = 0x70 | Number((random >> 70n) & 0x0fn);
  bytes[7] = Number((random >> 62n) & 0xffn);
  bytes[8] = 0x80 | Number((random >> 56n) & 0x3fn);

  let remaining = random & ((1n << 56n) - 1n);
  for (let index = 15; index >= 9; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(
    12,
    16,
  )}-${value.slice(16, 20)}-${value.slice(20)}`;
}
