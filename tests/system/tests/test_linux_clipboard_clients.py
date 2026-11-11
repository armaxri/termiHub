"""Unit tests for termihub_harness.linux_clipboard_clients (#5170).

Machinery group (no app, no display, no real clipboard): the payload parsers,
the skip decision and the second-client command lines, with a stubbed runner.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from termihub_harness import linux_clipboard_clients as clients


def _runner(returncode: int, stdout: bytes = b"", stderr: bytes = b""):
    calls: list[dict] = []

    def run(argv, **kwargs):
        calls.append({"argv": argv, **kwargs})
        return subprocess.CompletedProcess(argv, returncode, stdout, stderr)

    return run, calls


# ── skip decision ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_skip_reason_off_linux(platform):
    assert (
        clients.skip_reason(clients.X11_TOOLS, platform=platform, which=lambda _t: "/bin/x")
        == "the Linux clipboard owners are Linux-only"
    )


def test_skip_reason_names_missing_tools_on_linux():
    present = {"Xvfb"}
    reason = clients.skip_reason(
        (*clients.X11_TOOLS, *clients.WAYLAND_TOOLS),
        platform="linux",
        which=lambda t: "/usr/bin/" + t if t in present else None,
    )
    assert reason == "clipboard second-client tools not on PATH: xclip, sway, wl-paste, wl-copy"


def test_skip_reason_none_when_everything_is_there():
    assert clients.skip_reason(clients.X11_TOOLS, platform="linux", which=lambda t: t) is None


# ── payload parsing ──────────────────────────────────────────────────────────


def test_parse_uri_list_splits_crlf_and_drops_comments():
    data = b"# a comment\r\nfile:///tmp/a.txt\r\nfile:///tmp/b%20c.txt\r\n"
    assert clients.parse_uri_list(data) == ["file:///tmp/a.txt", "file:///tmp/b%20c.txt"]


def test_parse_uri_list_empty():
    assert clients.parse_uri_list(b"") == []


@pytest.mark.parametrize(
    "data",
    [b"file:///tmp/a.txt\nfile:///tmp/b.txt\n", b"file:///tmp/a.txt", b"file:///a\nb\r\n"],
)
def test_parse_uri_list_rejects_non_crlf(data):
    with pytest.raises(ValueError):
        clients.parse_uri_list(data)


def test_parse_copied_files():
    assert clients.parse_copied_files(b"copy\nfile:///tmp/a\nfile:///tmp/b") == (
        "copy",
        ["file:///tmp/a", "file:///tmp/b"],
    )


@pytest.mark.parametrize(
    "data",
    [b"copy\nfile:///tmp/a\n", b"copy\r\nfile:///tmp/a", b"move\nfile:///tmp/a"],
)
def test_parse_copied_files_rejects_malformed(data):
    with pytest.raises(ValueError):
        clients.parse_copied_files(data)


def test_file_uri_path_decodes_utf8():
    assert clients.file_uri_path("file:///tmp/caf%C3%A9%20%C3%BC.txt") == Path("/tmp/café ü.txt")
    assert clients.file_uri_path("file://localhost/tmp/a") == Path("/tmp/a")


@pytest.mark.parametrize("uri", ["http://x/tmp/a", "file://otherhost/tmp/a", "file:///tmp/%FF"])
def test_file_uri_path_rejects(uri):
    with pytest.raises(ValueError):
        clients.file_uri_path(uri)


def test_fetch_number():
    assert clients.fetch_number(Path("/tmp/root/fetch-12/a.txt")) == 12
    assert clients.fetch_number(Path("/tmp/root/other/a.txt")) is None


# ── second-client command lines ──────────────────────────────────────────────


def test_xclip_read_targets_the_given_display_and_selection(monkeypatch):
    monkeypatch.setenv("WAYLAND_DISPLAY", "wayland-9")
    run, calls = _runner(0, b"payload")
    read = clients.xclip_read(":42", "text/uri-list", run=run)
    assert read == clients.ClipboardRead(True, b"payload", "")
    call = calls[0]
    assert call["argv"] == [
        "xclip", "-display", ":42", "-selection", "clipboard", "-t", "text/uri-list", "-o",
    ]
    assert call["env"]["DISPLAY"] == ":42"
    assert "WAYLAND_DISPLAY" not in call["env"]
    assert call["timeout"] == clients.READ_TIMEOUT


def test_xclip_targets_lists_lines_or_none_without_owner():
    run, _ = _runner(0, b"TARGETS\ntext/uri-list\n")
    assert clients.xclip_targets(":1", run=run) == ["TARGETS", "text/uri-list"]
    run, _ = _runner(1, b"", b"Error: target TARGETS not available")
    assert clients.xclip_targets(":1", run=run) is None


def test_wl_paste_points_at_the_socket(monkeypatch):
    monkeypatch.setenv("DISPLAY", ":0")
    run, calls = _runner(0, b"text/uri-list\nx-special/gnome-copied-files\n")
    socket = Path("/run/thub-sway-x/wayland-1")
    assert clients.wl_types(socket, run=run) == ["text/uri-list", "x-special/gnome-copied-files"]
    call = calls[0]
    assert call["argv"] == ["wl-paste", "--no-newline", "--list-types"]
    assert call["env"]["WAYLAND_DISPLAY"] == str(socket)
    assert call["env"]["XDG_RUNTIME_DIR"] == str(socket.parent)
    assert "DISPLAY" not in call["env"]


def test_wl_types_none_when_nothing_is_copied():
    run, _ = _runner(1, b"", b"Nothing is copied")
    assert clients.wl_types(Path("/run/x/wayland-1"), run=run) is None


def test_read_reports_failure_and_stderr():
    run, _ = _runner(1, b"", b"refused")
    assert clients.wl_paste(Path("/run/x/wayland-1"), "--type", "text/plain", run=run) == (
        clients.ClipboardRead(False, b"", "refused")
    )


def test_stop_terminates_a_running_process_and_ignores_finished_ones():
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    clients.stop(proc)
    assert proc.returncode is not None
    clients.stop(proc)  # already finished: no error
    clients.stop(None)
