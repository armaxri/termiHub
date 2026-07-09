"""Unit tests for termihub_harness.clipboard (issue #957).

Machinery group (no app, no real clipboard): the per-OS command selection is
exercised with a stubbed subprocess runner and an injected ``system`` name, so
these run anywhere.
"""

from __future__ import annotations

from termihub_harness import clipboard as clipboard_mod
from termihub_harness import read_os_clipboard


def test_macos_uses_pbpaste(monkeypatch):
    calls = []
    monkeypatch.setattr(
        clipboard_mod, "_run_capture", lambda cmd: calls.append(cmd) or "hello"
    )
    assert read_os_clipboard(system="Darwin") == "hello"
    assert calls == [["pbpaste"]]


def test_windows_uses_get_clipboard(monkeypatch):
    calls = []
    monkeypatch.setattr(
        clipboard_mod, "_run_capture", lambda cmd: calls.append(cmd) or "win"
    )
    assert read_os_clipboard(system="Windows") == "win"
    assert calls[0][0] == "powershell"


def test_linux_falls_back_from_xclip_to_xsel(monkeypatch):
    calls = []

    def fake_run(cmd):
        calls.append(cmd[0])
        return "sel" if cmd[0] == "xsel" else None  # xclip absent, xsel works

    monkeypatch.setattr(clipboard_mod, "_run_capture", fake_run)
    assert read_os_clipboard(system="Linux") == "sel"
    assert calls == ["xclip", "xsel"]


def test_linux_none_when_no_tool(monkeypatch):
    monkeypatch.setattr(clipboard_mod, "_run_capture", lambda _cmd: None)
    assert read_os_clipboard(system="Linux") is None


def test_unknown_platform_returns_none(monkeypatch):
    monkeypatch.setattr(clipboard_mod, "_run_capture", lambda _cmd: "x")
    assert read_os_clipboard(system="Plan9") is None
