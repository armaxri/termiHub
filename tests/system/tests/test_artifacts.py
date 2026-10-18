"""Unit tests for failure-artifact capture (no app launch).

Drives :func:`write_failure_artifacts` with stub driver/app objects, so the
bundle-writing logic is covered without building or launching the app.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from termihub_harness import screenshot_to_png_bytes
from termihub_harness import artifacts as artifacts_mod
from termihub_harness.artifacts import (
    sanitize_nodeid,
    save_manual_screenshot,
    write_failure_artifacts,
)

# A 1×1 transparent PNG, the smallest valid capture to round-trip through base64.
_PNG_1X1 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class _StubDriver:
    def __init__(self, state=None, terminal="", state_exc=None):
        self._state = state if state is not None else {"activePanelId": "p1"}
        self._terminal = terminal
        self._state_exc = state_exc
        #: The last ``timeout`` the probes passed — so a test can assert the
        #: failure path uses the long diagnostic timeout (#2460).
        self.timeouts_seen: list = []

    def get_state(self, *, timeout=None):
        self.timeouts_seen.append(timeout)
        if self._state_exc is not None:
            raise self._state_exc
        return self._state

    def read_terminal(self, *, timeout=None):
        self.timeouts_seen.append(timeout)
        return self._terminal


class _ScreenshotDriver(_StubDriver):
    """A driver that also supports the ``screenshot`` verb (#900)."""

    def __init__(self, *, data_url=None, screenshot_exc=None, **kwargs):
        super().__init__(**kwargs)
        self._data_url = data_url
        self._screenshot_exc = screenshot_exc

    def screenshot(self, *, timeout=None):
        self.timeouts_seen.append(timeout)
        if self._screenshot_exc is not None:
            raise self._screenshot_exc
        return self._data_url


class _StubApp:
    def __init__(self, log=""):
        self._log = log

    def read_log(self):
        return self._log


def test_sanitize_nodeid_strips_separators():
    out = sanitize_nodeid("tests/test_x.py::TestX::test_y")
    assert "/" not in out and ":" not in out
    assert out == "tests_test_x.py__TestX__test_y"


def test_sanitize_nodeid_never_empty():
    assert sanitize_nodeid("///") == "test"


def test_writes_all_three_sources(tmp_path: Path):
    driver = _StubDriver(state={"foo": 1, "bar": [2, 3]}, terminal="$ ls\nfile\n")
    app = _StubApp(log="app booted\nSpawning local shell\n")
    dest = write_failure_artifacts(tmp_path / "bundle", driver, app)

    assert json.loads((dest / "state.json").read_text()) == {"foo": 1, "bar": [2, 3]}
    assert (dest / "terminal.txt").read_text() == "$ ls\nfile\n"
    assert (dest / "app.log").read_text() == "app booted\nSpawning local shell\n"


def test_missing_driver_or_app_is_skipped(tmp_path: Path):
    dest = write_failure_artifacts(tmp_path / "only-app", None, _StubApp(log="x"))
    assert (dest / "app.log").read_text() == "x"
    assert not (dest / "state.json").exists()
    assert not (dest / "terminal.txt").exists()


def test_probe_error_is_recorded_not_raised(tmp_path: Path):
    # A broken bridge during a failure must not raise — it records its own error.
    driver = _StubDriver(state_exc=RuntimeError("bridge gone"))
    dest = write_failure_artifacts(tmp_path / "broken", driver, None)
    assert (dest / "state.json.error.txt").read_text() == "RuntimeError: bridge gone"
    # The terminal probe still ran independently.
    assert (dest / "terminal.txt").exists()


def test_no_screenshot_verb_skips_the_png(tmp_path: Path):
    # The base stub has no `screenshot` method (older app / non-#900 driver).
    dest = write_failure_artifacts(tmp_path / "no-shot", _StubDriver(), None)
    assert not (dest / "screenshot.png").exists()


def test_writes_screenshot_when_driver_supports_it(tmp_path: Path):
    driver = _ScreenshotDriver(data_url=f"data:image/png;base64,{_PNG_1X1}")
    dest = write_failure_artifacts(tmp_path / "shot", driver, None)
    png = (dest / "screenshot.png").read_bytes()
    assert png.startswith(_PNG_SIGNATURE)


def test_screenshot_capture_error_is_recorded_not_raised(tmp_path: Path):
    driver = _ScreenshotDriver(
        terminal="$ ls\n", screenshot_exc=RuntimeError("capture gone")
    )
    dest = write_failure_artifacts(tmp_path / "shot-broken", driver, None)
    assert (dest / "screenshot.png.error.txt").read_text() == "RuntimeError: capture gone"
    # The other probes still ran independently.
    assert (dest / "terminal.txt").read_text() == "$ ls\n"


def test_writes_probe_diagnostics_with_timed_records(tmp_path: Path):
    # The bundle records a timed line per probe — the #2460 slow-vs-hung signal.
    driver = _ScreenshotDriver(
        data_url=f"data:image/png;base64,{_PNG_1X1}", terminal="$ ls\n"
    )
    app = _StubApp(log="app booted\n")
    dest = write_failure_artifacts(tmp_path / "diag", driver, app)
    text = (dest / "probe-diagnostics.txt").read_text()
    for name in ("state.json", "terminal.txt", "screenshot.png", "app.log"):
        assert f"{name}: ok in " in text
    assert "#2460" in text


def test_probe_diagnostics_records_a_failed_probe_as_timed(tmp_path: Path):
    # A hung/slow probe that raises (e.g. a bridge timeout) is recorded as a
    # timed FAILED line, not silently dropped — the definitive #2460 evidence.
    driver = _StubDriver(state_exc=RuntimeError("command timed out after 60.0s"))
    dest = write_failure_artifacts(tmp_path / "hung", driver, None)
    text = (dest / "probe-diagnostics.txt").read_text()
    assert "state.json: FAILED after" in text
    assert "RuntimeError: command timed out after 60.0s" in text


def test_probe_diagnostics_written_even_with_no_driver_or_app(tmp_path: Path):
    dest = write_failure_artifacts(tmp_path / "empty", None, None)
    assert (dest / "probe-diagnostics.txt").read_text().strip().endswith("no probes ran")


def test_failure_probes_use_the_long_diagnostic_timeout(tmp_path: Path):
    # The failure path must outlive the live path's own (possibly raised) command
    # timeout, so every bridge probe runs with DIAGNOSTIC_PROBE_TIMEOUT (#2460).
    driver = _ScreenshotDriver(data_url=f"data:image/png;base64,{_PNG_1X1}")
    write_failure_artifacts(tmp_path / "to", driver, None, probe_timeout=42.0)
    assert driver.timeouts_seen == [42.0, 42.0, 42.0]


def test_save_manual_screenshot_writes_png_and_returns_a_path(tmp_path, monkeypatch):
    # A guided-manual observation must return a *file path*, never the raw
    # data: URL (which would flood the operator console / report — #957).
    monkeypatch.setattr(artifacts_mod, "ARTIFACT_ROOT", tmp_path)
    driver = _ScreenshotDriver(data_url=f"data:image/png;base64,{_PNG_1X1}")
    path = save_manual_screenshot(driver, "tests/t.py::T::test_x")
    assert path is not None
    assert path.suffix == ".png" and path.exists()
    assert not str(path).startswith("data:")
    assert path.read_bytes().startswith(_PNG_SIGNATURE)


def test_save_manual_screenshot_none_without_screenshot_verb(tmp_path, monkeypatch):
    monkeypatch.setattr(artifacts_mod, "ARTIFACT_ROOT", tmp_path)
    assert save_manual_screenshot(_StubDriver(), "tests/t.py::T::test_x") is None


def test_save_manual_screenshot_keeps_each_observation(tmp_path, monkeypatch):
    monkeypatch.setattr(artifacts_mod, "ARTIFACT_ROOT", tmp_path)
    driver = _ScreenshotDriver(data_url=f"data:image/png;base64,{_PNG_1X1}")
    first = save_manual_screenshot(driver, "tests/t.py::T::test_x")
    second = save_manual_screenshot(driver, "tests/t.py::T::test_x")
    assert first != second and first.exists() and second.exists()


def test_save_manual_screenshot_capture_error_returns_none(tmp_path, monkeypatch):
    monkeypatch.setattr(artifacts_mod, "ARTIFACT_ROOT", tmp_path)
    driver = _ScreenshotDriver(screenshot_exc=RuntimeError("capture gone"))
    assert save_manual_screenshot(driver, "tests/t.py::T::test_x") is None


def test_screenshot_to_png_bytes_accepts_data_url_and_bare_base64():
    from_data_url = screenshot_to_png_bytes(f"data:image/png;base64,{_PNG_1X1}")
    from_bare = screenshot_to_png_bytes(_PNG_1X1)
    assert from_data_url == from_bare
    assert from_data_url.startswith(_PNG_SIGNATURE)


def test_screenshot_to_png_bytes_rejects_malformed_base64():
    with pytest.raises(ValueError):
        screenshot_to_png_bytes("data:image/png;base64,not valid base64!!")


class _BridgeDriver(_StubDriver):
    """A driver with the multi-window bridge's socket state and event log (#4861)."""

    def __init__(self, *, connected=True, events=(), replacement=None, **kwargs):
        super().__init__(**kwargs)
        self.window_label = "main"
        self.is_connected = connected
        self._events = list(events)
        self._replacement = replacement

    def bridge_events(self):
        return self._events

    def live_replacement(self):
        return self._replacement


class _LiveApp(_StubApp):
    def __init__(self, *, running, returncode=None, **kwargs):
        super().__init__(**kwargs)
        self._running = running
        self.pid = 4242
        self.returncode = returncode

    def is_running(self):
        return self._running


def test_bundle_records_bridge_events_socket_state_and_app_liveness(tmp_path: Path):
    events = [
        "11:17:01.300Z connect window=main conn=#1",
        "11:17:07.140Z close window=main conn=#1 code=1006 reason=''",
    ]
    driver = _BridgeDriver(connected=False, events=events)
    dest = write_failure_artifacts(tmp_path / "b", driver, _LiveApp(running=True))
    assert (dest / "bridge-events.txt").read_text() == "\n".join(events) + "\n"
    text = (dest / "probe-diagnostics.txt").read_text()
    assert "app process: running (pid 4242)" in text
    assert "driver socket (main): CLOSED" in text
    assert "bridge-events.txt: ok in " in text


def test_bundle_records_an_exited_app(tmp_path: Path):
    dest = write_failure_artifacts(
        tmp_path / "x", None, _LiveApp(running=False, returncode=-11)
    )
    assert "app process: EXITED (code -11)" in (dest / "probe-diagnostics.txt").read_text()


def test_bundle_probes_through_a_reconnected_page(tmp_path: Path):
    # The page reloaded onto a new socket: probe through it and say so (#4861).
    fresh = _StubDriver(state={"windowLabel": "main"})
    driver = _BridgeDriver(connected=False, replacement=fresh, state_exc=RuntimeError("closed"))
    dest = write_failure_artifacts(tmp_path / "r", driver, None)
    assert json.loads((dest / "state.json").read_text()) == {"windowLabel": "main"}
    assert "reconnected on a new socket" in (dest / "probe-diagnostics.txt").read_text()


# --- macOS crash-report capture (#4875) ---------------------------------------

_LAUNCH = 1_800_000_000.0


def _report(directory: Path, name: str, mtime: float) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text(f"report {name}")
    os.utime(path, (mtime, mtime))
    return path


class _LaunchedApp(_StubApp):
    def __init__(self, *, started=_LAUNCH, returncode=None, **kwargs):
        super().__init__(**kwargs)
        self.first_started_at = started
        self.returncode = returncode


def test_select_crash_reports_filters_by_time(tmp_path: Path):
    _report(tmp_path, "termiHub-2026-10-18-old.ips", _LAUNCH - 600)
    new = _report(tmp_path, "termiHub-2026-10-18-new.ips", _LAUNCH + 30)
    assert artifacts_mod.select_crash_reports([tmp_path], _LAUNCH) == [new]


def test_select_crash_reports_filters_by_name(tmp_path: Path):
    app = _report(tmp_path, "termihub-2026-10-18-1.crash", _LAUNCH + 1)
    upper = _report(tmp_path, "TERMIHUB-2026-10-18-2.ips", _LAUNCH + 2)
    webkit = _report(tmp_path, "com.apple.WebKit.WebContent-2026-10-18-3.ips", _LAUNCH + 3)
    _report(tmp_path, "Safari-2026-10-18.ips", _LAUNCH + 4)
    _report(tmp_path, "termiHub-2026-10-18.diag", _LAUNCH + 5)
    (tmp_path / "termiHub-dir.ips").mkdir()
    found = artifacts_mod.select_crash_reports([tmp_path, tmp_path / "missing"], _LAUNCH)
    assert found == [app, upper, webkit]


def test_collect_crash_reports_copies_into_the_bundle(tmp_path: Path):
    reports = tmp_path / "DiagnosticReports"
    _report(reports, "termiHub-2026-10-18-old.ips", _LAUNCH - 600)
    _report(reports, "termiHub-2026-10-18-new.ips", _LAUNCH + 30)
    dest = tmp_path / "bundle"
    record = artifacts_mod.collect_crash_reports(
        dest, _LaunchedApp(), report_dirs=[reports], system="Darwin", settle=0
    )
    assert record is not None and "1 found since app launch, 1 copied" in record
    copied = sorted(p.name for p in (dest / "crash-reports").iterdir())
    assert copied == ["termiHub-2026-10-18-new.ips"]


def test_collect_crash_reports_records_none_found(tmp_path: Path):
    dest = tmp_path / "bundle"
    record = artifacts_mod.collect_crash_reports(
        dest, _LaunchedApp(), report_dirs=[tmp_path / "empty"], system="Darwin", settle=0
    )
    assert record is not None and "0 found since app launch" in record
    assert not (dest / "crash-reports").exists()


def test_collect_crash_reports_is_a_noop_off_macos(tmp_path: Path):
    _report(tmp_path / "r", "termiHub-x.ips", _LAUNCH + 1)
    for system in ("Linux", "Windows"):
        record = artifacts_mod.collect_crash_reports(
            tmp_path / "b", _LaunchedApp(), report_dirs=[tmp_path / "r"], system=system
        )
        assert record is None
    assert not (tmp_path / "b").exists()


def test_collect_crash_reports_skips_an_app_without_launch_time(tmp_path: Path):
    record = artifacts_mod.collect_crash_reports(
        tmp_path / "b", _StubApp(), report_dirs=[tmp_path], system="Darwin"
    )
    assert record is None


def test_collect_crash_reports_waits_for_a_late_report_of_a_crashed_app(
    tmp_path: Path, monkeypatch
):
    reports = tmp_path / "r"
    reports.mkdir()
    polls = []

    def fake_sleep(_seconds):
        polls.append(1)
        if len(polls) == 2:  # ReportCrash writes the report a moment later
            _report(reports, "termiHub-late.ips", _LAUNCH + 5)

    monkeypatch.setattr(artifacts_mod.time, "sleep", fake_sleep)
    record = artifacts_mod.collect_crash_reports(
        tmp_path / "b",
        _LaunchedApp(returncode=-11),
        report_dirs=[reports],
        system="Darwin",
        settle=60,
    )
    assert record is not None and "1 found" in record
    assert (tmp_path / "b" / "crash-reports" / "termiHub-late.ips").exists()


def test_collect_crash_reports_never_raises(tmp_path: Path, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(artifacts_mod, "select_crash_reports", boom)
    record = artifacts_mod.collect_crash_reports(
        tmp_path / "b", _LaunchedApp(), report_dirs=[tmp_path], system="Darwin"
    )
    assert record == "crash reports: FAILED — RuntimeError: disk gone"


def test_bundle_notes_crash_reports_in_probe_diagnostics(tmp_path: Path, monkeypatch):
    reports = tmp_path / "r"
    _report(reports, "com.apple.WebKit.WebContent-1.ips", _LAUNCH + 3)
    monkeypatch.setattr(artifacts_mod, "MACOS_CRASH_REPORT_DIRS", (reports,))
    monkeypatch.setattr(artifacts_mod.platform, "system", lambda: "Darwin")
    dest = write_failure_artifacts(tmp_path / "b", None, _LaunchedApp(log="x"))
    text = (dest / "probe-diagnostics.txt").read_text()
    assert "crash reports: 1 found since app launch, 1 copied" in text
    assert (dest / "crash-reports" / "com.apple.WebKit.WebContent-1.ips").exists()
