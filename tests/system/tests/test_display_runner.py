"""Unit tests for termihub_harness.display_runner (issue #2526).

Machinery group (no app, no real WindowServer): the per-OS availability logic is
exercised with injected ``launchctl managername`` / ``ioreg`` outputs, so these
run anywhere — including headless CI, which is exactly the environment whose
*absence* of a display-backed runner the guard must report. The activation levers
(caffeinate / osascript) are best-effort side effects and are not asserted here;
their contract is "never raise", covered by the off-platform no-op checks.
"""

from __future__ import annotations

import pytest

from termihub_harness import display_runner as dr
from termihub_harness import (
    DisplayRunnerUnavailable,
    display_backed_runner_available,
    ensure_display_backed_runner,
    probe_display_runner,
)

# A representative ``ioreg -n Root -d1`` console blob for a logged-in, unlocked
# desktop session (trimmed to the fields the probe reads).
CONSOLE_UNLOCKED = (
    '    "IOConsoleLocked" = No\n'
    '    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,'
    '"kCGSessionLoginDoneKey"=Yes,"kCGSSessionScreenIsLocked"=No,'
    '"kCGSSessionUserNameKey"="arne"})\n'
)
CONSOLE_LOCKED = (
    '    "IOConsoleLocked" = Yes\n'
    '    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,'
    '"kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenIsLocked"=Yes})\n'
)
CONSOLE_LOGIN_WINDOW = (
    '    "IOConsoleLocked" = No\n'
    '    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes})\n'  # login not done
)
CONSOLE_NO_SESSION = '    "IOConsoleLocked" = No\n    "IOConsoleUsers" = ()\n'


def _probe(managername, console, system="Darwin"):
    return probe_display_runner(
        system=system,
        _managername=lambda: managername,
        _console=lambda: console,
    )


def test_macos_aqua_unlocked_is_available():
    status = _probe("Aqua", CONSOLE_UNLOCKED)
    assert status.available
    assert "unlocked" in status.reason


def test_macos_non_aqua_session_is_unavailable():
    status = _probe("Background", CONSOLE_UNLOCKED)
    assert not status.available
    assert "Aqua" in status.reason  # names the actual blocker


def test_macos_missing_managername_is_unavailable():
    status = _probe(None, CONSOLE_UNLOCKED)
    assert not status.available


def test_macos_locked_console_is_unavailable():
    status = _probe("Aqua", CONSOLE_LOCKED)
    assert not status.available
    assert "lock" in status.reason.lower()


def test_macos_login_window_is_unavailable():
    status = _probe("Aqua", CONSOLE_LOGIN_WINDOW)
    assert not status.available
    assert "login" in status.reason.lower()


def test_macos_no_console_session_is_unavailable():
    status = _probe("Aqua", CONSOLE_NO_SESSION)
    assert not status.available


def test_macos_unreadable_ioreg_is_unavailable():
    status = _probe("Aqua", None)
    assert not status.available


def test_non_macos_is_always_available():
    # webkit2gtk / WebView2 do not park timers the WKWebView way, so the guard
    # must not over-restrict other platforms.
    for system in ("Linux", "Windows"):
        status = probe_display_runner(system=system)
        assert status.available


def test_available_boolean_matches_probe(monkeypatch):
    monkeypatch.setattr(dr, "_launchctl_managername", lambda: "Aqua")
    monkeypatch.setattr(dr, "_ioreg_console", lambda: CONSOLE_UNLOCKED)
    assert display_backed_runner_available("Darwin") is True


def test_ensure_raises_when_unavailable(monkeypatch):
    monkeypatch.setattr(dr, "_launchctl_managername", lambda: "Background")
    monkeypatch.setattr(dr, "_ioreg_console", lambda: CONSOLE_UNLOCKED)
    with pytest.raises(DisplayRunnerUnavailable):
        ensure_display_backed_runner("Darwin")


def test_ensure_returns_status_when_available(monkeypatch):
    monkeypatch.setattr(dr, "_launchctl_managername", lambda: "Aqua")
    monkeypatch.setattr(dr, "_ioreg_console", lambda: CONSOLE_UNLOCKED)
    status = ensure_display_backed_runner("Darwin")
    assert status.available


def test_keep_display_awake_is_noop_off_macos(monkeypatch):
    monkeypatch.setattr(dr.platform, "system", lambda: "Linux")
    assert dr.keep_display_awake() is None
    dr.release_display_awake(None)  # tolerates None


def test_bring_app_foreground_is_noop_off_macos(monkeypatch):
    monkeypatch.setattr(dr.platform, "system", lambda: "Linux")
    assert dr.bring_app_foreground(1234) is False
