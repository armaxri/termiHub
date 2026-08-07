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
import time
from pathlib import Path
from typing import Any, Callable, Optional

#: Where bundles are written (git-ignored). One subdir per failing test node id.
ARTIFACT_ROOT = Path(__file__).resolve().parents[1] / "artifacts"

#: Command timeout for the failure-path diagnostic probes (issue #2460). A bridge
#: verb that times out is exactly when the bundle matters most, but the probes run
#: on the *same* webview that just hung — so with the normal (possibly already
#: raised) command timeout they would time out again and capture nothing. This
#: generous ceiling lets a webview that is merely **slow under VM load** still
#: return a screenshot / state late, and turns a genuinely **hung** one into a
#: definitive timed "FAILED after Ns" record (see :func:`write_failure_artifacts`
#: and ``probe-diagnostics.txt``) rather than silence — the #2460 slow-vs-hung
#: verdict.
DIAGNOSTIC_PROBE_TIMEOUT = 60.0


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


def _record_probe_error(path: Path, exc: BaseException) -> None:
    """Write a failed probe's error beside its target as ``<name>.error.txt``.

    Capture must never raise — a broken bridge during a failure is exactly when
    the bundle matters most, so a failed probe records its own error rather than
    masking the original test failure.
    """
    try:
        path.with_suffix(path.suffix + ".error.txt").write_text(
            f"{type(exc).__name__}: {exc}", encoding="utf-8"
        )
    except OSError:
        pass


def _safe_write(path: Path, produce: Callable[[], str]) -> None:
    """Write ``produce()`` text to ``path``; record the error beside it on failure."""
    try:
        path.write_text(produce(), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        _record_probe_error(path, exc)


def _safe_write_bytes(path: Path, produce: Callable[[], bytes]) -> None:
    """Binary counterpart of :func:`_safe_write` for the screenshot PNG."""
    try:
        path.write_bytes(produce())
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        _record_probe_error(path, exc)


def _capture_screenshot_png(driver: Any, *, timeout: Optional[float] = None) -> bytes:
    """Capture a PNG screenshot via the bridge and decode it to raw bytes.

    Imported lazily so this module keeps no hard dependency on the bridge for its
    unit tests, and so a driver stub without ``screenshot`` is simply skipped by
    the ``hasattr`` guard in :func:`write_failure_artifacts`.

    ``timeout`` overrides the driver's default command timeout — the failure path
    passes :data:`DIAGNOSTIC_PROBE_TIMEOUT` so a slow (not-yet-hung) webview can
    still return a screenshot (issue #2460).
    """
    from .bridge import screenshot_to_png_bytes

    return screenshot_to_png_bytes(driver.screenshot(timeout=timeout))


def save_manual_screenshot(
    driver: Any, nodeid: str, *, label: Optional[str] = None
) -> Optional[Path]:
    """Persist a guided-manual observation screenshot; return its path or ``None``.

    Guided-manual ``observe`` steps attach a screenshot (#900). The bridge hands
    back a ``data:image/png;base64,…`` URL, which must **never** be surfaced raw —
    it would flood the operator console and bloat the JSON report. So this decodes
    it to a PNG under the per-test artifacts dir and returns the *file path* to
    reference instead. Returns ``None`` when the bridge lacks the screenshot verb
    (older app / driver stub) or capture fails — best-effort, like the failure
    bundle, so a broken capture never masks the test result.
    """
    if not hasattr(driver, "screenshot"):
        return None
    dest_dir = ARTIFACT_ROOT / sanitize_nodeid(nodeid)
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = f"observe-{sanitize_nodeid(label)}" if label else "observe"
    dest = dest_dir / f"{stem}.png"
    suffix = 2
    while dest.exists():  # keep every observation in a test, don't overwrite
        dest = dest_dir / f"{stem}-{suffix}.png"
        suffix += 1
    _safe_write_bytes(dest, lambda: _capture_screenshot_png(driver))
    return dest if dest.exists() else None


def _timed_probe(
    dest: Path, name: str, produce: Callable[[], Any], *, binary: bool = False
) -> str:
    """Run one capture probe, timing it, and return a one-line diagnostic record.

    Writes ``produce()`` to ``dest/name`` on success (text, or bytes when
    ``binary``), or records its error beside the target on failure — capture is
    best-effort and must never raise (a broken bridge during a failure is exactly
    when the bundle matters most). The returned record — ``"<name>: ok in Ns"`` or
    ``"<name>: FAILED after Ns — Type: msg"`` — is the #2460 slow-vs-hung signal:
    a probe that returns *late* means the webview was slow-not-hung; one that
    times out at the probe ceiling means it is genuinely hung.
    """
    target = dest / name
    start = time.monotonic()
    try:
        output = produce()
        elapsed = time.monotonic() - start
        if binary:
            target.write_bytes(output)
        else:
            target.write_text(output, encoding="utf-8")
        return f"{name}: ok in {elapsed:.1f}s"
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        elapsed = time.monotonic() - start
        _record_probe_error(target, exc)
        return f"{name}: FAILED after {elapsed:.1f}s — {type(exc).__name__}: {exc}"


def write_failure_artifacts(
    dest: Path,
    driver: Optional[Any],
    app: Optional[Any],
    *,
    probe_timeout: float = DIAGNOSTIC_PROBE_TIMEOUT,
) -> Path:
    """Snapshot whatever app-side state is reachable into ``dest``; return ``dest``.

    ``driver`` / ``app`` may be ``None`` (e.g. a non-integration test) — each
    source is captured only when present:

    - ``driver.get_state()`` → ``state.json``
    - ``driver.read_terminal()`` → ``terminal.txt``
    - ``driver.screenshot()`` → ``screenshot.png`` (when the bridge supports it)
    - ``app.read_log()`` → ``app.log``
    - a timed record of every probe → ``probe-diagnostics.txt``

    The bridge probes run with ``probe_timeout`` (default
    :data:`DIAGNOSTIC_PROBE_TIMEOUT`), *not* the driver's normal command timeout:
    a live-connect verb that just timed out did so on the same webview, so the
    probes need to outlive that to capture anything from a slow-but-alive webview.
    ``probe-diagnostics.txt`` records how long each probe took and whether it
    returned or timed out — the #2460 slow-vs-hung verdict (issue #2460).
    """
    dest.mkdir(parents=True, exist_ok=True)
    records: list[str] = []
    if driver is not None:
        records.append(
            _timed_probe(
                dest,
                "state.json",
                lambda: json.dumps(
                    driver.get_state(timeout=probe_timeout),
                    indent=2,
                    default=str,
                    sort_keys=True,
                ),
            )
        )
        records.append(
            _timed_probe(
                dest, "terminal.txt", lambda: driver.read_terminal(timeout=probe_timeout)
            )
        )
        # The screenshot verb (#900) may be absent on older apps / driver stubs —
        # capture it only when present so the bundle gains visual evidence where
        # available without breaking where it is not.
        if hasattr(driver, "screenshot"):
            records.append(
                _timed_probe(
                    dest,
                    "screenshot.png",
                    lambda: _capture_screenshot_png(driver, timeout=probe_timeout),
                    binary=True,
                )
            )
    if app is not None:
        records.append(_timed_probe(dest, "app.log", app.read_log))
    # Always leave the timed record — it is the #2460 evidence, and its header
    # explains how to read a slow-vs-hung result even when no probe ran.
    header = (
        "# Failure-artifact probe diagnostics (issue #2460).\n"
        f"# Bridge probes ran with a {probe_timeout:.0f}s timeout.\n"
        "# 'ok in Ns' = the webview answered (late N => slow-not-hung);\n"
        "# 'FAILED after ~{}s' at the ceiling => the webview is genuinely hung.\n".format(
            int(probe_timeout)
        )
    )
    _safe_write(
        dest / "probe-diagnostics.txt",
        lambda: header + ("\n".join(records) + "\n" if records else "# no probes ran\n"),
    )
    return dest
