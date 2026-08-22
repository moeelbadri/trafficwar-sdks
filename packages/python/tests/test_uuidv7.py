import os
import select
import threading
import uuid

import pytest

from trafficwar import _uuidv7


def test_uuidv7_sets_rfc9562_version_and_variant_bits() -> None:
    parsed = uuid.UUID(_uuidv7.uuid7())

    assert parsed.version == 7
    assert parsed.variant == uuid.RFC_4122


def test_uuidv7_is_unique_and_monotonic_with_stalled_or_backward_clock(
    monkeypatch,
) -> None:
    logical_now = max(_uuidv7._last_timestamp + 1, _uuidv7._time_millis() + 10_000)
    values = iter([logical_now, logical_now, logical_now - 5_000])
    monkeypatch.setattr(_uuidv7, "_time_millis", lambda: next(values))

    generated = [_uuidv7.uuid7(), _uuidv7.uuid7(), _uuidv7.uuid7()]

    assert len(set(generated)) == len(generated)
    assert generated == sorted(generated)
    assert [int(value.replace("-", "")[:12], 16) for value in generated] == [
        logical_now,
        logical_now,
        logical_now,
    ]


def test_uuidv7_generation_is_thread_safe() -> None:
    generated: list[str] = []
    lock = threading.Lock()

    def generate() -> None:
        values = [_uuidv7.uuid7() for _ in range(250)]
        with lock:
            generated.extend(values)

    threads = [threading.Thread(target=generate) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(generated) == 1_000
    assert len(set(generated)) == 1_000


@pytest.mark.skipif(
    not hasattr(os, "fork") or not hasattr(os, "register_at_fork"),
    reason="requires POSIX fork hooks",
)
def test_uuidv7_resets_inherited_locked_state_after_fork() -> None:
    read_fd, write_fd = os.pipe()
    inherited_lock = _uuidv7._lock
    inherited_lock.acquire()
    child_pid = -1

    try:
        child_pid = os.fork()
        if child_pid == 0:
            os.close(read_fd)
            try:
                reset = (
                    _uuidv7._pid == os.getpid()
                    and _uuidv7._last_timestamp == -1
                    and _uuidv7._last_random == 0
                )
                fresh_lock = _uuidv7._lock.acquire(blocking=False)
                if fresh_lock:
                    _uuidv7._lock.release()
                value = _uuidv7.uuid7()
                payload = f"{int(reset)}|{int(fresh_lock)}|{value}".encode()
                os.write(write_fd, payload)
                os._exit(0)
            except BaseException as error:
                os.write(write_fd, f"error|{error!r}".encode(errors="replace"))
                os._exit(1)
    finally:
        if child_pid != 0:
            inherited_lock.release()
            os.close(write_fd)

    ready, _, _ = select.select([read_fd], [], [], 2.0)
    timed_out = not ready
    if timed_out:
        os.kill(child_pid, 9)
        payload = b""
    else:
        payload = os.read(read_fd, 1024)
    os.close(read_fd)
    waited_pid, status = os.waitpid(child_pid, 0)

    assert not timed_out, "child deadlocked on the inherited UUIDv7 lock"
    assert waited_pid == child_pid
    assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
    reset, fresh_lock, value = payload.decode().split("|")
    assert reset == "1"
    assert fresh_lock == "1"
    assert uuid.UUID(value).version == 7
