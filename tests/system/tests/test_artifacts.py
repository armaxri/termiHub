"""Unit tests for failure-artifact capture (no app launch).

Drives :func:`write_failure_artifacts` with stub driver/app objects, so the
bundle-writing logic is covered without building or launching the app.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from termihub_harness import screenshot_to_png_bytes
from termihub_harness.artifacts import sanitize_nodeid, write_failure_artifacts

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

    def get_state(self):
        if self._state_exc is not None:
            raise self._state_exc
        return self._state

    def read_terminal(self):
        return self._terminal


class _ScreenshotDriver(_StubDriver):
    """A driver that also supports the ``screenshot`` verb (#900)."""

    def __init__(self, *, data_url=None, screenshot_exc=None, **kwargs):
        super().__init__(**kwargs)
        self._data_url = data_url
        self._screenshot_exc = screenshot_exc

    def screenshot(self):
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


def test_screenshot_to_png_bytes_accepts_data_url_and_bare_base64():
    from_data_url = screenshot_to_png_bytes(f"data:image/png;base64,{_PNG_1X1}")
    from_bare = screenshot_to_png_bytes(_PNG_1X1)
    assert from_data_url == from_bare
    assert from_data_url.startswith(_PNG_SIGNATURE)


def test_screenshot_to_png_bytes_rejects_malformed_base64():
    with pytest.raises(ValueError):
        screenshot_to_png_bytes("data:image/png;base64,not valid base64!!")
