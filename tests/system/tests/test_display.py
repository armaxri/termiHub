"""Unit tests for termihub_harness.display (issue #957).

Machinery group (no app, no real X server): the per-OS branch selection and the
XQuartz start-and-wait loop are exercised with stubbed subprocess helpers and an
injected ``system`` name, so these run anywhere. ``os.environ`` is mutated only
via ``monkeypatch`` so it is restored after each test.
"""

from __future__ import annotations

from termihub_harness import display as display_mod
from termihub_harness import ensure_local_display


def test_macos_uses_launchd_display_and_exports_it(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(display_mod, "_macos_launchd_display", lambda: "/tmp/x:0")
    started = []
    monkeypatch.setattr(display_mod, "_start_xquartz", lambda: started.append(True))
    result = ensure_local_display(start_if_missing=True, system="Darwin")
    assert result == "/tmp/x:0"
    assert display_mod.os.environ["DISPLAY"] == "/tmp/x:0"
    assert started == []  # already had a display — never started XQuartz


def test_macos_does_not_start_xquartz_when_not_allowed(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(display_mod, "_macos_launchd_display", lambda: None)
    started = []
    monkeypatch.setattr(display_mod, "_start_xquartz", lambda: started.append(True))
    result = ensure_local_display(start_if_missing=False, system="Darwin")
    assert result is None
    assert started == []
    assert "DISPLAY" not in display_mod.os.environ


def test_macos_starts_xquartz_then_reads_the_published_display(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(display_mod.time, "sleep", lambda _s: None)
    state = {"started": False}
    monkeypatch.setattr(
        display_mod,
        "_macos_launchd_display",
        lambda: "/tmp/x:0" if state["started"] else None,
    )
    monkeypatch.setattr(
        display_mod, "_start_xquartz", lambda: state.__setitem__("started", True)
    )
    result = ensure_local_display(start_if_missing=True, system="Darwin")
    assert result == "/tmp/x:0"
    assert display_mod.os.environ["DISPLAY"] == "/tmp/x:0"


def test_macos_gives_up_when_xquartz_never_publishes(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.setattr(display_mod.time, "sleep", lambda _s: None)
    monkeypatch.setattr(display_mod, "_macos_launchd_display", lambda: None)
    monkeypatch.setattr(display_mod, "_start_xquartz", lambda: None)
    assert ensure_local_display(start_if_missing=True, system="Darwin") is None
    assert "DISPLAY" not in display_mod.os.environ


def test_linux_uses_existing_display(monkeypatch):
    monkeypatch.setenv("DISPLAY", ":0")
    assert ensure_local_display(start_if_missing=True, system="Linux") == ":0"


def test_linux_returns_none_when_unset(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    assert ensure_local_display(start_if_missing=True, system="Linux") is None


def test_windows_returns_none_and_exports_nothing(monkeypatch):
    monkeypatch.delenv("DISPLAY", raising=False)
    assert ensure_local_display(start_if_missing=True, system="Windows") is None
    assert "DISPLAY" not in display_mod.os.environ
