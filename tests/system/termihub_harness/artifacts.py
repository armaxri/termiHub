"""Failure-artifact capture for integration system tests (local-workflow P2).

When an integration test fails, the app is about to be torn down and its state is
gone. To make a failure diagnosable from CI logs or a headless agent run — where
no one was watching the window — :func:`write_failure_artifacts` snapshots the
app's store state, the terminal buffer, and the captured app log into a per-test
bundle. The pytest hook in ``conftest.py`` calls this on a failing test.

Kept as a small standalone module (not buried in ``conftest``) so the writing
logic is unit-testable with stub driver/app objects, no app launch needed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable, Optional

#: Where bundles are written (git-ignored). One subdir per failing test node id.
ARTIFACT_ROOT = Path(__file__).resolve().parents[1] / "artifacts"


def sanitize_nodeid(nodeid: str) -> str:
    """Turn a pytest node id into a safe single-path-segment directory name.

    ``tests/test_x.py::TestX::test_y`` → ``tests_test_x.py__TestX__test_y`` — no
    slashes or colons, so it nests cleanly under :data:`ARTIFACT_ROOT`.
    """
    safe = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in nodeid)
    # Collapse the runs of underscores the separators (``/`` ``::``) leave behind.
    while "___" in safe:
        safe = safe.replace("___", "__")
    return safe.strip("_") or "test"


def _safe_write(path: Path, produce: Callable[[], str]) -> None:
    """Write ``produce()`` to ``path``; on error, write the error beside it.

    Capture must never raise — a broken bridge during a failure is exactly when
    the bundle matters most, so a failed probe records its own error rather than
    masking the original test failure.
    """
    try:
        path.write_text(produce(), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        try:
            path.with_suffix(path.suffix + ".error.txt").write_text(
                f"{type(exc).__name__}: {exc}", encoding="utf-8"
            )
        except OSError:
            pass


def _safe_write_bytes(path: Path, produce: Callable[[], bytes]) -> None:
    """Binary counterpart of :func:`_safe_write` for the screenshot PNG."""
    try:
        path.write_bytes(produce())
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        try:
            path.with_suffix(path.suffix + ".error.txt").write_text(
                f"{type(exc).__name__}: {exc}", encoding="utf-8"
            )
        except OSError:
            pass


def _capture_screenshot_png(driver: Any) -> bytes:
    """Capture a PNG screenshot via the bridge and decode it to raw bytes.

    Imported lazily so this module keeps no hard dependency on the bridge for its
    unit tests, and so a driver stub without ``screenshot`` is simply skipped by
    the ``hasattr`` guard in :func:`write_failure_artifacts`.
    """
    from .bridge import screenshot_to_png_bytes

    return screenshot_to_png_bytes(driver.screenshot())


def write_failure_artifacts(dest: Path, driver: Optional[Any], app: Optional[Any]) -> Path:
    """Snapshot whatever app-side state is reachable into ``dest``; return ``dest``.

    ``driver`` / ``app`` may be ``None`` (e.g. a non-integration test) — each
    source is captured only when present:

    - ``driver.get_state()`` → ``state.json``
    - ``driver.read_terminal()`` → ``terminal.txt``
    - ``driver.screenshot()`` → ``screenshot.png`` (when the bridge supports it)
    - ``app.read_log()`` → ``app.log``
    """
    dest.mkdir(parents=True, exist_ok=True)
    if driver is not None:
        _safe_write(
            dest / "state.json",
            lambda: json.dumps(driver.get_state(), indent=2, default=str, sort_keys=True),
        )
        _safe_write(dest / "terminal.txt", driver.read_terminal)
        # The screenshot verb (#900) may be absent on older apps / driver stubs —
        # capture it only when present so the bundle gains visual evidence where
        # available without breaking where it is not.
        if hasattr(driver, "screenshot"):
            _safe_write_bytes(dest / "screenshot.png", lambda: _capture_screenshot_png(driver))
    if app is not None:
        _safe_write(dest / "app.log", app.read_log)
    return dest
