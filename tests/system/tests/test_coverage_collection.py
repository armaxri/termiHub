"""Harness-side coverage collection (TOOL-005 follow-up, #3657).

Runs against a real bridge server and fake app windows, so no built app is
needed: the chunked ``readCoverage`` read, the per-window dump files, the
``exitApp`` normal-exit request for an LLVM-instrumented app, the "collect
once, whichever of app-stop / bridge-close comes first" registry, and that all
of it stays completely inert when ``TERMIHUB_HARNESS_COVERAGE_DIR`` is unset.
"""

from __future__ import annotations

import json
import threading

import pytest

from fake_app import FakeApp, dispatcher_like
from termihub_harness import coverage, orchestrator
from termihub_harness.bridge import Bridge

COVERAGE = {
    "/repo/src/a.ts": {
        "path": "/repo/src/a.ts",
        "statementMap": {"0": {"start": {"line": 1, "column": 0}, "end": {"line": 1, "column": 9}}},
        "s": {"0": 4},
    }
}


class FakeProcessApp:
    """The slice of AppInstance the coverage module uses."""

    def __init__(self, pid: int = 4242, exits_on_request: bool = True) -> None:
        self.pid = pid
        self.running = True
        self.exit_requested = threading.Event()
        self.exits_on_request = exits_on_request

    def is_running(self) -> bool:
        return self.running

    def wait_exited(self, timeout: float) -> bool:
        if self.exits_on_request and self.exit_requested.wait(timeout):
            self.running = False
            return True
        return False


@pytest.fixture
def cov_dir(tmp_path, monkeypatch):
    out = tmp_path / "harness-coverage"
    monkeypatch.setenv(coverage.COVERAGE_DIR_ENV, str(out))
    monkeypatch.delenv(coverage.LLVM_PROFILE_ENV, raising=False)
    coverage.reset_for_tests()
    yield out
    coverage.reset_for_tests()


def exit_recording(handler, app: FakeProcessApp):
    def handle(command):
        if command.get("action") == "exitApp":
            app.exit_requested.set()
        return handler(command)

    return handle


def dumps(out):
    return sorted((out / "frontend").glob("*.json")) if (out / "frontend").exists() else []


def test_read_frontend_coverage_pages_through_chunks(cov_dir):
    text = json.dumps(COVERAGE)
    server = Bridge().start()
    try:
        with FakeApp(server.port, dispatcher_like(coverage=text, coverage_chunk=7)):
            driver = server.wait_for_app(timeout=5)
            assert coverage.read_frontend_coverage(driver) == text
    finally:
        server.close()


def test_read_frontend_coverage_is_none_for_an_uninstrumented_build(cov_dir):
    server = Bridge().start()
    try:
        with FakeApp(server.port, dispatcher_like()):
            driver = server.wait_for_app(timeout=5)
            assert coverage.read_frontend_coverage(driver) is None
    finally:
        server.close()


def test_read_detects_a_snapshot_that_changed_mid_read():
    class Shifting:
        def read_coverage_chunk(self, offset=0, *, timeout=None):
            return {"total": 10 + offset, "offset": offset, "chunk": "x" * 5}

        def exit_app(self):
            pass

    with pytest.raises(ValueError, match="changed mid-read"):
        coverage.read_frontend_coverage(Shifting())


def test_bridge_close_dumps_every_window_once(cov_dir):
    app = FakeProcessApp()
    server = Bridge().start()
    coverage.register_app(app, server.port)
    text = json.dumps(COVERAGE)
    with FakeApp(server.port, dispatcher_like(coverage=text), window="main"):
        server.wait_for_app(timeout=5)
        with FakeApp(server.port, dispatcher_like(coverage=text), window="win-1"):
            server.window("win-1", timeout=5)
            server.close()
            # A later app stop for the same process collects nothing again.
            coverage.before_app_stop(app)
    files = dumps(cov_dir)
    assert len(files) == 2
    assert {json.loads(f.read_text()) == COVERAGE for f in files} == {True}
    assert any("-main-4242-" in f.name for f in files)
    assert any("-win-1-4242-" in f.name for f in files)
    assert not list((cov_dir / "frontend").glob("*.tmp"))


def test_app_stop_requests_a_normal_exit_when_llvm_profiling(cov_dir, monkeypatch):
    monkeypatch.setenv(coverage.LLVM_PROFILE_ENV, "/tmp/termihub-%p-%m.profraw")
    app = FakeProcessApp()
    server = Bridge().start()
    try:
        coverage.register_app(app, server.port)
        handler = exit_recording(dispatcher_like(coverage=json.dumps(COVERAGE)), app)
        with FakeApp(server.port, handler):
            server.wait_for_app(timeout=5)
            coverage.before_app_stop(app)
        assert app.exit_requested.is_set()
        assert not app.running
        assert len(dumps(cov_dir)) == 1
    finally:
        server.close()


def test_no_exit_request_without_an_llvm_profile(cov_dir):
    app = FakeProcessApp()
    server = Bridge().start()
    try:
        coverage.register_app(app, server.port)
        with FakeApp(server.port, exit_recording(dispatcher_like(), app)):
            server.wait_for_app(timeout=5)
            coverage.before_app_stop(app)
        assert not app.exit_requested.is_set()
        assert dumps(cov_dir) == []  # uninstrumented build: nothing to write
    finally:
        server.close()


def test_inert_when_the_output_dir_is_unset(tmp_path, monkeypatch):
    monkeypatch.delenv(coverage.COVERAGE_DIR_ENV, raising=False)
    coverage.reset_for_tests()
    app = FakeProcessApp()
    server = Bridge().start()
    try:
        coverage.register_app(app, server.port)
        with FakeApp(server.port, exit_recording(dispatcher_like(coverage="{}"), app)):
            server.wait_for_app(timeout=5)
            coverage.before_app_stop(app)
            assert coverage._apps == {} and coverage._bridges == {}
        assert not app.exit_requested.is_set()
    finally:
        server.close()
    assert not list(tmp_path.rglob("*.json"))


def test_a_failing_read_never_raises(cov_dir):
    app = FakeProcessApp()
    server = Bridge().start()
    try:
        coverage.register_app(app, server.port)

        def broken(command):
            return {"ok": False, "action": command.get("action"), "error": "boom"}

        with FakeApp(server.port, broken):
            server.wait_for_app(timeout=5)
            coverage.before_app_stop(app)  # must not raise
        assert dumps(cov_dir) == []
    finally:
        server.close()


class _Popen:
    pid = 5151
    stdout = None

    def __init__(self):
        self.returncode = None

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode


def test_app_instance_stop_collects_before_the_kill(cov_dir, tmp_path, monkeypatch):
    """AppInstance.start/stop wire the hook in; the dump precedes the kill."""
    events = []
    monkeypatch.setattr(orchestrator, "app_binary_path", lambda: tmp_path / "app")
    monkeypatch.setattr(orchestrator.subprocess, "Popen", lambda *_a, **_k: _Popen())
    monkeypatch.setattr(orchestrator, "_children_of", lambda _p: [])
    monkeypatch.setattr(orchestrator, "_terminate_webview2_children", lambda *_a: None)
    monkeypatch.setattr(
        orchestrator, "_terminate_tree", lambda *_a, **_k: events.append("kill")
    )
    real_collect = coverage.collect
    monkeypatch.setattr(
        coverage, "collect", lambda port: (events.append("collect"), real_collect(port))
    )
    server = Bridge().start()
    try:
        app = orchestrator.AppInstance(config_dir=tmp_path)
        app.start(server.port)
        with FakeApp(server.port, dispatcher_like(coverage=json.dumps(COVERAGE))):
            server.wait_for_app(timeout=5)
            app.stop()
        assert events == ["collect", "kill"]
        assert len(dumps(cov_dir)) == 1
    finally:
        server.close()


def test_dump_name_uses_the_test_id_and_is_filesystem_safe():
    name = coverage.dump_name(
        "main", 77, "tests/test_x.py::TestLocal::test_a[x/y] (teardown)"
    )
    assert name.startswith("TestLocal-test_a_x_y_-main-77-")
    assert "/" not in name and " " not in name
