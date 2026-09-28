"""Coverage collection from harness-launched apps (TOOL-005 follow-up, #3657).

Opt-in and advisory. Nothing here runs unless ``TERMIHUB_HARNESS_COVERAGE_DIR``
names an output directory, and no failure in here ever fails a test: a coverage
problem prints a ``[termihub-coverage]`` line and the teardown carries on.

Two kinds of coverage are collected, both **just before an app is stopped**
(suite teardown, a test's ``app.restart()``, or a bridge closing under a
still-running app):

* **Frontend.** A build made with ``build-system-test-app.sh --coverage`` is
  Istanbul-instrumented (``TERMIHUB_FRONTEND_COVERAGE=1``), so every window's
  page keeps a ``window.__coverage__`` object. It is read over the bridge in
  chunks (``readCoverage``) and written to
  ``$TERMIHUB_HARNESS_COVERAGE_DIR/frontend/<name>.json``, one file per window
  per app launch. ``scripts/internal/istanbul-to-lcov.mjs`` turns the lot into
  one lcov file.
* **Desktop backend.** When the app was built under ``cargo llvm-cov show-env``
  and ``LLVM_PROFILE_FILE`` is set, the process only writes its ``.profraw``
  when it exits normally; the harness's usual kill loses it. So the harness
  asks the app to quit (``exitApp`` → ``AppHandle::exit(0)``) and waits for it
  to go before the kill. ``cargo llvm-cov report`` reads the profiles later.

The app and its bridge only meet through a port number (``app.start(port)``),
and the fixtures stop them in either order, so both register here by that port.
Whichever of ``AppInstance.stop()`` and ``Bridge.close()`` runs first while the
other is still alive does the collection, once per app process.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Optional, Protocol

#: Output directory for coverage dumps; unset = coverage collection off.
COVERAGE_DIR_ENV = "TERMIHUB_HARNESS_COVERAGE_DIR"
#: Set by ``cargo llvm-cov show-env``; its presence means the app is
#: LLVM-instrumented and must exit normally to write its profile.
LLVM_PROFILE_ENV = "LLVM_PROFILE_FILE"
#: Per-command budget for a coverage chunk read (serializing the whole object
#: happens on the first chunk and can take a moment on a busy runner).
CHUNK_TIMEOUT = 60.0
#: How long to find a live window's driver before giving up on it.
WINDOW_TIMEOUT = 5.0
#: How long a normal exit (teardown included) may take before the kill.
EXIT_TIMEOUT = 20.0
#: Upper bound on chunk reads for one snapshot (4 MiB chunks → 1 GiB).
MAX_CHUNKS = 256


class _Driver(Protocol):
    def read_coverage_chunk(
        self, offset: int = 0, *, timeout: Optional[float] = None
    ) -> Optional[dict[str, Any]]: ...

    def exit_app(self) -> None: ...


def output_dir() -> Optional[Path]:
    """The coverage output directory, or ``None`` when collection is off."""
    raw = os.environ.get(COVERAGE_DIR_ENV, "").strip()
    return Path(raw) if raw else None


def enabled() -> bool:
    return output_dir() is not None


def llvm_profile_enabled() -> bool:
    return bool(os.environ.get(LLVM_PROFILE_ENV, "").strip())


def log(message: str) -> None:
    try:
        print(f"[termihub-coverage] {message}", file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def read_frontend_coverage(driver: _Driver) -> Optional[str]:
    """The window's whole serialized ``window.__coverage__``, or ``None``.

    ``None`` means the build is not instrumented. Pages through one snapshot
    with ``readCoverage`` and checks every chunk belongs to it.
    """
    first = driver.read_coverage_chunk(0, timeout=CHUNK_TIMEOUT)
    if first is None:
        return None
    total = int(first["total"])
    parts = [first["chunk"]]
    received = len(first["chunk"])
    for _ in range(MAX_CHUNKS):
        if received >= total:
            break
        chunk = driver.read_coverage_chunk(received, timeout=CHUNK_TIMEOUT)
        if chunk is None or int(chunk["total"]) != total or int(chunk["offset"]) != received:
            raise ValueError(f"coverage snapshot changed mid-read at offset {received}")
        if not chunk["chunk"]:
            raise ValueError(f"empty coverage chunk at offset {received} of {total}")
        parts.append(chunk["chunk"])
        received += len(chunk["chunk"])
    if received != total:
        raise ValueError(f"coverage read stopped at {received} of {total} chars")
    return "".join(parts)


def dump_name(window: str, app_pid: Optional[int], test_id: Optional[str] = None) -> str:
    """A unique, filesystem-safe file stem for one window's dump."""
    test = test_id if test_id is not None else os.environ.get("PYTEST_CURRENT_TEST", "")
    # "tests/test_x.py::TestY::test_z (teardown)" -> "TestY-test_z"
    parts = [p for p in test.split(" ")[0].split("::")[1:] if p]
    label = "-".join(parts) or "session"
    slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{label}-{window}")[:100]
    return f"{slug}-{app_pid or 0}-{uuid.uuid4().hex[:8]}"


def write_frontend_coverage(text: str, out_dir: Path, name: str) -> Path:
    """Write one dump atomically to ``out_dir/frontend/<name>.json``."""
    json.loads(text)  # never leave a truncated file for the converter to trip on
    target_dir = out_dir / "frontend"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{name}.json"
    tmp = target.with_suffix(".json.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(target)
    return target


# ── Registry: the app and its bridge, keyed by the bridge port ───────────────

_lock = threading.Lock()
_bridges: dict[int, Any] = {}
_apps: dict[int, Any] = {}
_collected: set[int] = set()


def register_bridge(bridge: Any) -> None:
    if enabled():
        with _lock:
            _bridges[bridge.port] = bridge


def register_app(app: Any, port: int) -> None:
    if enabled():
        with _lock:
            _apps[port] = app


def unregister_bridge(bridge: Any) -> None:
    with _lock:
        for port, known in list(_bridges.items()):
            if known is bridge:
                del _bridges[port]


def unregister_app(app: Any) -> None:
    with _lock:
        for port, known in list(_apps.items()):
            if known is app:
                del _apps[port]


def before_app_stop(app: Any) -> None:
    """Hook for ``AppInstance.stop()``: collect while the process still runs."""
    if not enabled():
        return
    with _lock:
        port = next((p for p, known in _apps.items() if known is app), None)
    if port is not None:
        collect(port)


def before_bridge_close(bridge: Any) -> None:
    """Hook for ``Bridge.close()``: collect while the bridge still listens."""
    if not enabled():
        return
    with _lock:
        port = next((p for p, known in _bridges.items() if known is bridge), None)
    if port is not None:
        collect(port)


def collect(port: int) -> None:
    """Dump frontend coverage and flush the backend profile for one app launch.

    Runs at most once per app process. Never raises.
    """
    out = output_dir()
    if out is None:
        return
    with _lock:
        app = _apps.get(port)
        bridge = _bridges.get(port)
        pid = getattr(app, "pid", None) if app is not None else None
        if app is None or pid is None or pid in _collected or not app.is_running():
            return
        _collected.add(pid)
    if bridge is None:
        log(f"app pid {pid}: bridge already closed; no coverage collected")
        return
    try:
        labels = bridge.windows()
    except Exception as exc:  # noqa: BLE001 - advisory, never fail a teardown
        log(f"app pid {pid}: cannot list bridge windows ({exc})")
        return
    main = None
    for label in labels:
        try:
            driver = bridge.window(label, timeout=WINDOW_TIMEOUT)
            if main is None:
                main = driver
            text = read_frontend_coverage(driver)
            if text is None:
                log(f"app pid {pid} window {label!r}: build is not instrumented")
                continue
            path = write_frontend_coverage(text, out, dump_name(label, pid))
            log(f"app pid {pid} window {label!r}: wrote {path.name} ({len(text)} chars)")
        except Exception as exc:  # noqa: BLE001 - advisory
            log(f"app pid {pid} window {label!r}: frontend coverage failed ({exc})")
    if llvm_profile_enabled():
        _exit_normally(app, main, pid)


def _exit_normally(app: Any, driver: Optional[_Driver], pid: int) -> None:
    """Ask the app to quit and wait, so its LLVM profile gets written."""
    if driver is None:
        log(f"app pid {pid}: no live window to request a normal exit through")
        return
    try:
        driver.exit_app()
    except Exception as exc:  # noqa: BLE001 - advisory
        log(f"app pid {pid}: exitApp failed ({exc}); the backend profile may be lost")
        return
    if app.wait_exited(EXIT_TIMEOUT):
        log(f"app pid {pid}: exited normally (backend profile written)")
    else:
        log(f"app pid {pid}: still running {EXIT_TIMEOUT}s after exitApp; killing it")


def reset_for_tests() -> None:
    """Forget every registration (unit tests only)."""
    with _lock:
        _bridges.clear()
        _apps.clear()
        _collected.clear()
