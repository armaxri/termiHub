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
import platform
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Sequence

from . import deadlines

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
DIAGNOSTIC_PROBE_TIMEOUT = deadlines.DIAGNOSTIC_PROBE


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


def record_failed_attempt(
    dest: Path, attempt: int, phase: str, error_text: str, *, append: bool = False
) -> Optional[Path]:
    """Persist one failed test attempt's error as ``attempt-<n>-failure.txt``.

    Under pytest-rerunfailures the failure bundle is rewritten by every failing
    attempt, so only the *last* attempt's state survives. A rerun that fails
    for a different reason (e.g. on state the first attempt left behind) would
    then hide the real first error (#4829). One small text file per attempt
    keeps every attempt's error in the bundle. Pass ``append=True`` for a later
    failing phase of the same attempt (e.g. teardown after call); otherwise a
    stale file from an earlier session is replaced. Returns the file written,
    or ``None`` if it could not be written — best-effort, never raises.
    """
    try:
        dest.mkdir(parents=True, exist_ok=True)
        target = dest / f"attempt-{attempt}-failure.txt"
        with target.open("a" if append else "w", encoding="utf-8") as fh:
            fh.write(f"=== attempt {attempt}, {phase} phase ===\n")
            fh.write(error_text.rstrip("\n") + "\n")
        return target
    except Exception:  # noqa: BLE001 — capture must never mask the failure
        return None


def _window_label(driver: Any) -> str:
    return str(getattr(driver, "window_label", "?"))


def _app_liveness(app: Any) -> str:
    """One record saying whether the app process was still alive (#4861).

    Tells "the app crashed" apart from "one window's page died": both close the
    bridge socket, but only the first ends the process.
    """
    try:
        if app.is_running():
            return f"app process: running (pid {app.pid})"
        return f"app process: EXITED (code {app.returncode})"
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        return f"app process: unknown — {type(exc).__name__}: {exc}"


def _bridge_records(dest: Path, driver: Any) -> list[str]:
    """Write ``bridge-events.txt`` and return the driver's socket state record."""
    records: list[str] = []
    connected = getattr(driver, "is_connected", None)
    if connected is not None:
        state = "open" if connected else "CLOSED"
        records.append(f"driver socket ({_window_label(driver)}): {state}")
    events = getattr(driver, "bridge_events", None)
    if callable(events):
        records.append(
            _timed_probe(dest, "bridge-events.txt", lambda: "\n".join(events()) + "\n")
        )
    return records


def _live_replacement(driver: Any) -> Optional[Any]:
    finder = getattr(driver, "live_replacement", None)
    if not callable(finder):
        return None
    try:
        return finder()
    except Exception:  # noqa: BLE001 — capture is best-effort by design
        return None


#: Where macOS writes per-user crash reports (#4875).
MACOS_CRASH_REPORT_DIRS: tuple[Path, ...] = (
    Path.home() / "Library" / "Logs" / "DiagnosticReports",
)

#: Lower-cased crash-report name prefixes worth keeping: the app itself, and the
#: WebKit content process whose death blanks a window without ending the app.
CRASH_REPORT_PREFIXES: tuple[str, ...] = ("termihub", "com.apple.webkit.webcontent")

#: Crash-report file extensions (``.ips`` on current macOS, ``.crash`` on older).
CRASH_REPORT_SUFFIXES: tuple[str, ...] = (".ips", ".crash")

#: Slack subtracted from the launch time: file mtimes and ``time.time()`` can
#: disagree by a little, and a report from just before launch is harmless.
_CRASH_REPORT_SLACK = 2.0

#: How long to wait for ReportCrash to write the report of an app that exited
#: abnormally — it lands a few seconds after the process dies.
CRASH_REPORT_SETTLE = 10.0


def select_crash_reports(
    report_dirs: Iterable[Path],
    since: float,
    *,
    prefixes: Sequence[str] = CRASH_REPORT_PREFIXES,
    suffixes: Sequence[str] = CRASH_REPORT_SUFFIXES,
) -> list[Path]:
    """Crash reports in ``report_dirs`` modified at or after ``since`` (#4875).

    Only top-level files whose lower-cased name starts with one of ``prefixes``
    and ends with one of ``suffixes`` count. Missing or unreadable directories
    are skipped. Returned oldest first.
    """
    found: list[tuple[float, Path]] = []
    for directory in report_dirs:
        try:
            entries = list(Path(directory).iterdir())
        except OSError:
            continue
        for entry in entries:
            name = entry.name.lower()
            if not name.startswith(tuple(prefixes)) or not name.endswith(tuple(suffixes)):
                continue
            try:
                if not entry.is_file():
                    continue
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if mtime >= since:
                found.append((mtime, entry))
    return [path for _, path in sorted(found)]


def _app_exited_abnormally(app: Any) -> bool:
    try:
        code = app.returncode
    except Exception:  # noqa: BLE001 — capture is best-effort by design
        return False
    return code is not None and code != 0


def collect_crash_reports(
    dest: Path,
    app: Any,
    *,
    report_dirs: Optional[Iterable[Path]] = None,
    system: Optional[str] = None,
    settle: float = CRASH_REPORT_SETTLE,
) -> Optional[str]:
    """Copy this app instance's macOS crash reports into ``dest/crash-reports``.

    Settles #4875's question — did the app crash, or did only a window's WebKit
    content process die? — from one failure. Copies the app's and WebContent's
    reports modified since the instance first launched, and returns a one-line
    record for ``probe-diagnostics.txt``. Returns ``None`` (no record) off macOS
    or when the app has no launch time. Never raises.

    When the app exited abnormally and no report is there yet, waits up to
    ``settle`` seconds: ReportCrash writes the report a little after the crash.
    """
    try:
        if (system or platform.system()) != "Darwin":
            return None
        started = getattr(app, "first_started_at", None)
        if not isinstance(started, (int, float)):
            return None
        dirs = list(MACOS_CRASH_REPORT_DIRS if report_dirs is None else report_dirs)
        since = started - _CRASH_REPORT_SLACK
        reports = select_crash_reports(dirs, since)
        if not reports and settle > 0 and _app_exited_abnormally(app):
            deadline = time.monotonic() + settle
            while not reports and time.monotonic() < deadline:
                time.sleep(0.5)
                reports = select_crash_reports(dirs, since)
        copied = 0
        errors: list[str] = []
        if reports:
            target = dest / "crash-reports"
            target.mkdir(parents=True, exist_ok=True)
            for report in reports:
                try:
                    shutil.copy2(report, target / report.name)
                    copied += 1
                except OSError as exc:
                    errors.append(f"{report.name}: {exc}")
        record = (
            f"crash reports: {len(reports)} found since app launch, {copied} copied "
            "to crash-reports/"
        )
        if reports:
            record += " (" + ", ".join(p.name for p in reports) + ")"
        if errors:
            record += "; copy errors: " + "; ".join(errors)
        return record
    except Exception as exc:  # noqa: BLE001 — capture is best-effort by design
        return f"crash reports: FAILED — {type(exc).__name__}: {exc}"


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
    - the bridge's connect/close log → ``bridge-events.txt`` (#4861)
    - a timed record of every probe → ``probe-diagnostics.txt``, plus whether the
      app process was still running and whether the driver's socket was open
    - on macOS, the app's and WebKit WebContent's crash reports since the app
      launched → ``crash-reports/`` (#4875)

    The bridge probes run with ``probe_timeout`` (default
    :data:`DIAGNOSTIC_PROBE_TIMEOUT`), *not* the driver's normal command timeout:
    a live-connect verb that just timed out did so on the same webview, so the
    probes need to outlive that to capture anything from a slow-but-alive webview.
    ``probe-diagnostics.txt`` records how long each probe took and whether it
    returned or timed out — the #2460 slow-vs-hung verdict (issue #2460).
    """
    dest.mkdir(parents=True, exist_ok=True)
    records: list[str] = []
    if app is not None and hasattr(app, "is_running"):
        records.append(_app_liveness(app))
    if driver is not None:
        records.extend(_bridge_records(dest, driver))
        # A page that reloaded (e.g. after its webview process died) reconnects
        # on a new socket; probe through that one so the bundle still captures
        # its state, and say so (#4861).
        replacement = _live_replacement(driver)
        if replacement is not None:
            records.append(
                f"driver: window {_window_label(driver)!r} reconnected on a new socket; "
                "probes below used the new connection"
            )
            driver = replacement
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
        crash_record = collect_crash_reports(dest, app)
        if crash_record is not None:
            records.append(crash_record)
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
