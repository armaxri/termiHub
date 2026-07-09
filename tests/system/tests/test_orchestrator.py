"""Unit tests for the orchestrator's built-app discovery (no app launch).

Covers the release/debug/override resolution added so the fast local loop can run
against a `pnpm tauri build --debug` artifact instead of only a release build.
These are machinery tests (no `integration` marker) — they monkeypatch the repo
root and platform, so they need no build and run anywhere.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest

from termihub_harness import orchestrator


@pytest.fixture
def fake_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the orchestrator at an empty temp 'repo' and a Linux layout."""
    monkeypatch.setattr(orchestrator, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(orchestrator.platform, "system", lambda: "Linux")
    monkeypatch.delenv("TERMIHUB_TEST_APP_BINARY", raising=False)
    return tmp_path


def _make_binary(repo: Path, profile: str) -> Path:
    """Create a stub app binary under ``target/<profile>`` for the Linux layout."""
    path = repo / "target" / profile / "termihub"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    return path


def test_prefers_release_over_debug(fake_repo: Path):
    release = _make_binary(fake_repo, "release")
    _make_binary(fake_repo, "debug")
    assert orchestrator.app_binary_path() == release


def test_falls_back_to_debug_build(fake_repo: Path):
    debug = _make_binary(fake_repo, "debug")
    assert orchestrator.app_binary_path() == debug


def test_env_override_wins(fake_repo: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _make_binary(fake_repo, "release")  # would otherwise be chosen
    override = tmp_path / "custom-termihub"
    override.write_text("#!/bin/sh\n")
    monkeypatch.setenv("TERMIHUB_TEST_APP_BINARY", str(override))
    assert orchestrator.app_binary_path() == override


def test_env_override_missing_file_raises(fake_repo: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("TERMIHUB_TEST_APP_BINARY", "/no/such/binary")
    with pytest.raises(FileNotFoundError, match="TERMIHUB_TEST_APP_BINARY"):
        orchestrator.app_binary_path()


def test_no_build_raises_with_both_paths(fake_repo: Path):
    with pytest.raises(FileNotFoundError) as exc:
        orchestrator.app_binary_path()
    # The error names both the release and debug locations it looked in.
    # Path objects render with OS-native separators (backslashes on Windows),
    # so normalize before the substring check to stay separator-agnostic.
    message = str(exc.value).replace("\\", "/")
    assert "target/release" in message
    assert "target/debug" in message


def test_candidates_are_release_then_debug(fake_repo: Path):
    release, debug = orchestrator.app_binary_candidates()
    assert release == fake_repo / "target/release/termihub"
    assert debug == fake_repo / "target/debug/termihub"


# ── WebView2 child reaping on Windows teardown (issue #1022) ──────────────────


class _FakeStdout:
    """A stdout stand-in the pump thread can iterate (empty) and close."""

    def __iter__(self):
        return iter(())

    def close(self):
        pass


class _FakePopen:
    """A subprocess.Popen stand-in that never really launches anything."""

    def __init__(self):
        self.pid = 4321
        self.stdout = _FakeStdout()

    def poll(self):
        return None


class _FakeProc:
    """A psutil.Process stand-in recording terminate()/kill() calls.

    ``cmdline()`` is a method (not cached in ``.info``) to mirror the reaper's
    lazy fetch — it only reads the command line for name-matched processes.
    """

    def __init__(self, name, cmdline, *, survives=False):
        self.info = {"name": name}
        self._cmdline = cmdline
        self.survives = survives
        self.terminated = False
        self.killed = False
        self.cmdline_read = False

    def cmdline(self):
        self.cmdline_read = True
        return self._cmdline

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


def test_is_webview2_matches_pinned_data_dir():
    data_dir = Path(r"C:\Temp\inst-1\webview2-user-data")
    assert orchestrator._is_webview2_for_data_dir(
        "msedgewebview2.exe",
        ["msedgewebview2.exe", f"--user-data-dir={data_dir}", "--type=renderer"],
        data_dir,
    )


def test_is_webview2_rejects_other_process_names():
    data_dir = Path(r"C:\Temp\inst-1\webview2-user-data")
    # The app process itself references the folder via env but must not be reaped.
    assert not orchestrator._is_webview2_for_data_dir(
        "termihub.exe", ["termihub.exe", str(data_dir)], data_dir
    )


def test_is_webview2_rejects_other_instances_data_dir():
    mine = Path(r"C:\Temp\inst-1\webview2-user-data")
    theirs = Path(r"C:\Temp\inst-2\webview2-user-data")
    assert not orchestrator._is_webview2_for_data_dir(
        "msedgewebview2.exe",
        ["msedgewebview2.exe", f"--user-data-dir={theirs}"],
        mine,
    )


def test_is_webview2_normalises_case_and_separators():
    # WebView2 may report the path with different casing / mixed separators.
    data_dir = Path(r"C:\Temp\inst-1\webview2-user-data")
    assert orchestrator._is_webview2_for_data_dir(
        "MsEdgeWebView2.exe",
        ["--user-data-dir=c:/temp/inst-1/webview2-user-data"],
        data_dir,
    )


def test_terminate_webview2_children_noop_off_windows(monkeypatch):
    monkeypatch.setattr(orchestrator.platform, "system", lambda: "Linux")

    def _fail(*_a, **_k):
        raise AssertionError("process_iter must not run off Windows")

    monkeypatch.setattr(orchestrator.psutil, "process_iter", _fail)
    # Must return without touching psutil at all.
    orchestrator._terminate_webview2_children(Path("/whatever"))


def test_terminate_webview2_children_reaps_only_matching(monkeypatch):
    monkeypatch.setattr(orchestrator.platform, "system", lambda: "Windows")
    data_dir = Path(r"C:\Temp\inst-1\webview2-user-data")

    match = _FakeProc(
        "msedgewebview2.exe", ["--user-data-dir=" + str(data_dir), "--type=gpu-process"]
    )
    stubborn = _FakeProc(
        "msedgewebview2.exe",
        ["--user-data-dir=" + str(data_dir), "--type=renderer"],
        survives=True,
    )
    other_instance = _FakeProc(
        "msedgewebview2.exe", [r"--user-data-dir=C:\Temp\inst-2\webview2-user-data"]
    )
    app_proc = _FakeProc("termihub.exe", ["termihub.exe", str(data_dir)])
    procs = [match, stubborn, other_instance, app_proc]

    monkeypatch.setattr(orchestrator.psutil, "process_iter", lambda _attrs: procs)
    monkeypatch.setattr(
        orchestrator.psutil,
        "wait_procs",
        lambda victims, timeout: ([], [p for p in victims if p.survives]),
    )

    orchestrator._terminate_webview2_children(data_dir)

    assert match.terminated and not match.killed
    assert stubborn.terminated and stubborn.killed  # escalated after surviving
    assert not other_instance.terminated  # different instance — left alone
    assert not app_proc.terminated  # not a WebView2 host — left alone
    # Name pre-filter must skip the costly cmdline read for non-WebView2 procs.
    assert not app_proc.cmdline_read


def _make_app(monkeypatch, tmp_path, system):
    """Build an AppInstance with launch fully stubbed, on the given platform."""
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: tmp_path / "app.exe")
    monkeypatch.setattr(orchestrator.platform, "system", lambda: system)
    monkeypatch.setattr(orchestrator, "_terminate_webview2_children", lambda *_a, **_k: None)
    # Never touch a real PID for the fake process on stop().
    monkeypatch.setattr(orchestrator, "_terminate_tree", lambda *_a, **_k: None)
    captured = {}

    def _fake_popen(_argv, *, env, **_kwargs):
        captured["env"] = env
        return _FakePopen()

    monkeypatch.setattr(orchestrator.subprocess, "Popen", _fake_popen)
    instance = orchestrator.AppInstance(config_dir=tmp_path)
    return instance, captured


def test_start_pins_webview2_folder_on_windows(tmp_path, monkeypatch):
    instance, captured = _make_app(monkeypatch, tmp_path, "Windows")
    instance.start(9999)
    try:
        assert captured["env"]["WEBVIEW2_USER_DATA_FOLDER"] == str(
            instance._webview2_data_dir
        )
        assert instance._webview2_data_dir == tmp_path / "webview2-user-data"
    finally:
        instance.stop()


def test_start_omits_webview2_folder_off_windows(tmp_path, monkeypatch):
    instance, captured = _make_app(monkeypatch, tmp_path, "Linux")
    instance.start(9999)
    try:
        assert "WEBVIEW2_USER_DATA_FOLDER" not in captured["env"]
    finally:
        instance.stop()


class _LinesStdout:
    """A stdout stand-in that yields the given lines then EOFs."""

    def __init__(self, lines):
        self._lines = lines

    def __iter__(self):
        return iter(self._lines)

    def close(self):
        pass


class _LinesPopen:
    """A Popen stand-in whose stdout replays ``lines``."""

    def __init__(self, lines):
        self.pid = 4322
        self.stdout = _LinesStdout(lines)

    def poll(self):
        return None


def _pump_instance(monkeypatch, tmp_path, *, echo_logs, lines):
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: tmp_path / "app.exe")
    inst = orchestrator.AppInstance(config_dir=tmp_path, echo_logs=echo_logs)
    inst._process = _LinesPopen(lines)
    inst._log_file = io.StringIO()
    return inst


def test_pump_echoes_to_console_when_enabled(tmp_path, monkeypatch, capsys):
    inst = _pump_instance(
        monkeypatch, tmp_path, echo_logs=True, lines=["boot A\n", "boot B\n"]
    )
    inst._pump_output()
    out = capsys.readouterr().out
    assert "boot A" in out and "boot B" in out
    assert "boot A" in inst._log_file.getvalue()  # and still captured


def test_pump_is_silent_on_console_when_disabled_but_still_logs(
    tmp_path, monkeypatch, capsys
):
    # Guided-manual runs disable the echo so prompts stay readable; the log file
    # must still receive everything (#957).
    inst = _pump_instance(monkeypatch, tmp_path, echo_logs=False, lines=["boot A\n"])
    inst._pump_output()
    assert capsys.readouterr().out == ""
    assert "boot A" in inst._log_file.getvalue()
