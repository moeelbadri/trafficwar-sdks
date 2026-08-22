"""Dependency-free, process-monotonic RFC 9562 UUIDv7 generation."""

import os
import secrets
import threading
import time
import uuid

_RANDOM_BITS = 74
_RANDOM_MASK = (1 << _RANDOM_BITS) - 1
_MAX_TIMESTAMP = (1 << 48) - 1

_lock = threading.Lock()
_pid = os.getpid()
_last_timestamp = -1
_last_random = 0


def _after_fork_child() -> None:
    """Replace inherited synchronization state without touching the old lock."""

    global _last_random, _last_timestamp, _lock, _pid

    _lock = threading.Lock()
    _pid = os.getpid()
    _last_timestamp = -1
    _last_random = 0


if hasattr(os, "register_at_fork"):
    os.register_at_fork(after_in_child=_after_fork_child)


def _time_millis() -> int:
    return time.time_ns() // 1_000_000


def _random_74_bits() -> int:
    return int.from_bytes(secrets.token_bytes(10), "big") & _RANDOM_MASK


def uuid7() -> str:
    """Return a UUIDv7 ordered after earlier calls in this process."""

    global _last_random, _last_timestamp, _pid

    now = _time_millis()
    if not 0 <= now <= _MAX_TIMESTAMP:
        raise RuntimeError("current time cannot be represented as UUIDv7")

    with _lock:
        current_pid = os.getpid()
        if current_pid != _pid:
            _pid = current_pid
            _last_timestamp = -1
            _last_random = 0

        if now > _last_timestamp:
            _last_timestamp = now
            _last_random = _random_74_bits()
        elif _last_random < _RANDOM_MASK:
            _last_random += 1
        else:
            if _last_timestamp >= _MAX_TIMESTAMP:
                raise RuntimeError("UUIDv7 timestamp space exhausted")
            _last_timestamp += 1
            _last_random = _random_74_bits()

        timestamp = _last_timestamp
        random_bits = _last_random

    rand_a = random_bits >> 62
    rand_b = random_bits & ((1 << 62) - 1)
    value = (timestamp << 80) | (0x7 << 76) | (rand_a << 64) | (0b10 << 62) | rand_b
    return str(uuid.UUID(int=value))
