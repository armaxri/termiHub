"""Display-backed runner for headless full-app **live** E2E (issue #2526).

This is a different concern from :mod:`termihub_harness.display` (which resolves
an X11 ``$DISPLAY`` for SSH X11-forwarding). Here we are after the macOS
**WKWebView occlusion/foreground throttle**: WebKit parks the page's JS timers /
``requestAnimationFrame`` whenever the window is not part of an *actively
composited, foreground* display session. The full-app live-E2E lane
(``tests/system``, the Python bridge driving the real bundle) hits this on the
frontend-dependent flows. (The agent-reconnect lane was the sharpest such case
under the old *client*-driven reconnect engine; that engine was deleted (#2558),
reconnect is now backend-driven (#2560), and the grade was automated headlessly
in ``test_agent_reconnect_ui.py`` (#2574), so it no longer needs this gate. The
levers below remain for any future frontend-dependent live flow.)

Everything tried so far lives *inside the app process* — the always-on-top pin
(#957), App-Nap defeat + ``NSWindowOcclusionDetectionEnabled=false`` + the
``document.hidden`` override (#2523), a 1 Hz bridge heartbeat, and
``caffeinate`` to hold the display awake. None of them un-park the timers,
because the missing ingredient is external to the app: the process must run in a
**GUI (Aqua) session with a live, unlocked, composited console** *and* its window
must be the **foreground/active** window — the exact state a human reproduces by
sitting in front of the machine and looking at it (which is why the maintainer's
manual grade passes).

This module supplies the two harness-side levers nobody had automated:

1. :func:`probe_display_runner` / :func:`ensure_display_backed_runner` — detect
   whether the current process is running under such a session, so a
   frontend-dependent live suite can **skip cleanly** with a precise reason on a
   headless / SSH / locked / login-window host instead of timing out. This is
   the *runner-detection guard* for frontend-dependent live suites.
2. :func:`keep_display_awake` + :func:`bring_app_foreground` — once a runner is
   present, hold the display awake and make the app the **foreground/key**
   application by pid, so WebKit keeps the page foreground-active and its timers
   tick un-throttled under automation.

**Provisioning a runner on a headless Mac (CI / no attached display).** The
detection intentionally reports *unavailable* on a bare ``ssh``-only or
lidded-clamshell Mac with no composited session, because a WKWebView spawned
there cannot attach to WindowServer at all. To make such a host a display-backed
runner, give it a real, composited GUI session — any one of:

* a **virtual display** WindowServer treats as real: a dummy-display driver or a
  ``BetterDummy``-style CoreDisplay virtual display (needs a one-time install +
  a logged-in-and-unlocked GUI session), or
* a **Screen-Sharing / VNC** connection into the host, which allocates a virtual
  framebuffer and composites a real session for a headless Mac, or
* a **dedicated auto-login GUI session** (loginwindow auto-login + disabled
  screen lock) with the test runner started *inside* it (e.g. via a LaunchAgent
  or ``launchctl asuser <uid>``), never over a plain SSH shell.

Then run ``tests/system`` from **within** that session (so the app it spawns
inherits it). Detection will flip to *available* and the frontend-dependent live
suites activate automatically — no test change needed.

The detection helpers take injectable seams (``_managername`` / ``_console``)
so the per-OS logic is unit-tested with no real WindowServer, mirroring
:mod:`termihub_harness.display`.
"""

from __future__ import annotations

import platform
import re
import subprocess
from dataclasses import dataclass
from typing import Callable, Optional

#: ``caffeinate`` assertion flags: -d (display), -i (idle), -s (system on AC),
#: -u (declare user active). Held for the lifetime of the returned process.
_CAFFEINATE_FLAGS = "-disu"


class DisplayRunnerUnavailable(RuntimeError):
    """No actively-composited GUI session to un-throttle the WKWebView.

    Raised by :func:`ensure_display_backed_runner`; a suite turns it into a
    ``pytest.skip`` at the call site, exactly like ``LocalAgentUnavailable``.
    """


@dataclass(frozen=True)
class DisplayRunnerStatus:
    """Whether a display-backed runner is present, plus a human-readable reason."""

    available: bool
    reason: str


# ── injectable subprocess seams ──────────────────────────────────────────────
def _launchctl_managername() -> Optional[str]:
    """The current session's launchd manager name (``Aqua`` in a GUI session).

    A process in the logged-in desktop session reports ``Aqua``; one launched
    over a plain SSH shell reports ``Background`` (or the call fails). This is the
    cheapest proxy for "a WKWebView spawned here can reach WindowServer". Any
    failure resolves to ``None`` (treated as *not* Aqua).
    """
    try:
        result = subprocess.run(
            ["launchctl", "managername"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() or None


def _ioreg_console() -> Optional[str]:
    """Raw ``ioreg -n Root -d1`` text carrying the console-lock / on-console user.

    Exposes ``IOConsoleLocked`` and ``IOConsoleUsers`` (with
    ``kCGSessionLoginDoneKey`` / ``kCGSessionOnConsoleKey`` and, when locked,
    ``CGSSessionScreenIsLocked``) without needing PyObjC/Quartz (absent from the
    harness venv). Any failure resolves to ``None``.
    """
    try:
        result = subprocess.run(
            ["ioreg", "-n", "Root", "-d1"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout or None


# ── per-OS analysis (pure; unit-tested with injected inputs) ──────────────────
def _macos_status(
    *, managername: Optional[str], console: Optional[str]
) -> DisplayRunnerStatus:
    """Decide runner availability on macOS from the two probes.

    Available only when **all** hold:

    * the process is in the GUI (``Aqua``) session — else a WKWebView cannot
      attach to WindowServer and never composites;
    * the console is **not locked** (``IOConsoleLocked`` is not ``Yes`` and the
      on-console session is not ``CGSSessionScreenIsLocked``);
    * a console login is **done** (``kCGSessionLoginDoneKey=Yes``) — i.e. a real
      desktop, not the login window.
    """
    if managername != "Aqua":
        got = managername or "unknown"
        return DisplayRunnerStatus(
            False,
            "not a GUI (Aqua) session "
            f"(launchd manager = {got!r}); a WKWebView spawned here cannot attach "
            "to WindowServer. Run tests/system from a logged-in desktop session, "
            "not a plain SSH shell — see display_runner.py for provisioning a "
            "display-backed runner (#2526).",
        )
    if console is None:
        return DisplayRunnerStatus(
            False, "could not read the console/lock state via ioreg"
        )
    if re.search(r'"IOConsoleLocked"\s*=\s*Yes', console):
        return DisplayRunnerStatus(
            False, "the console is locked (IOConsoleLocked=Yes) — unlock the screen"
        )
    # Apple spells these keys inconsistently — kCGSSessionOnConsoleKey (double S)
    # vs kCGSessionLoginDoneKey (single S) — so tolerate one-or-two S throughout.
    if re.search(r'"?k?CGSS?essionScreenIsLocked"?\s*=\s*Yes', console):
        return DisplayRunnerStatus(
            False, "the screen is locked (CGSSessionScreenIsLocked=Yes)"
        )
    if not re.search(r'"?kCGSS?essionOnConsoleKey"?\s*=\s*Yes', console):
        return DisplayRunnerStatus(
            False,
            "no active on-console GUI session (kCGSSessionOnConsoleKey not Yes) — "
            "the host has no composited display; provision a display-backed "
            "runner (virtual display / Screen-Sharing / auto-login session).",
        )
    if not re.search(r'"?kCGSS?essionLoginDoneKey"?\s*=\s*Yes', console):
        return DisplayRunnerStatus(
            False, "sitting at the login window (kCGSessionLoginDoneKey not Yes)"
        )
    return DisplayRunnerStatus(True, "Aqua console session, unlocked and logged in")


def probe_display_runner(
    system: Optional[str] = None,
    *,
    _managername: Optional[Callable[[], Optional[str]]] = None,
    _console: Optional[Callable[[], Optional[str]]] = None,
) -> DisplayRunnerStatus:
    """Report whether a display-backed runner is present for the current OS.

    * **macOS**: the real WKWebView-throttle guard (see :func:`_macos_status`).
    * **non-macOS**: always *available* — this throttle is a WKWebView (macOS)
      behaviour; webkit2gtk / WebView2 do not park timers the same way, so the
      guard must not over-restrict Linux/Windows live suites.

    The ``_managername`` / ``_console`` seams are injectable so the decision logic
    is unit-tested with no real WindowServer; when omitted they resolve to the
    module-level probes **at call time** (so a test can also monkeypatch those).
    """
    system = system or platform.system()
    if system != "Darwin":
        return DisplayRunnerStatus(
            True, f"{system}: no WKWebView occlusion/foreground throttle to guard"
        )
    managername = (_managername or _launchctl_managername)()
    console = (_console or _ioreg_console)()
    return _macos_status(managername=managername, console=console)


def display_backed_runner_available(system: Optional[str] = None) -> bool:
    """Convenience boolean over :func:`probe_display_runner`."""
    return probe_display_runner(system).available


def ensure_display_backed_runner(system: Optional[str] = None) -> DisplayRunnerStatus:
    """Return the status, or raise :class:`DisplayRunnerUnavailable` if not available.

    The call site (a frontend-dependent live suite) turns the exception into a
    ``pytest.skip`` — the same contract as ``LocalAgentUnavailable``.
    """
    status = probe_display_runner(system)
    if not status.available:
        raise DisplayRunnerUnavailable(status.reason)
    return status


# ── activation levers (best-effort; only meaningful once a runner is present) ─
def keep_display_awake() -> Optional[subprocess.Popen]:
    """Hold the display + system awake for as long as the returned process lives.

    Spawns ``caffeinate -disu``; call ``.terminate()`` on the handle (or let it
    die with the harness) to release. Returns ``None`` off macOS or if
    ``caffeinate`` cannot be spawned — callers treat it as best-effort.
    """
    if platform.system() != "Darwin":
        return None
    try:
        return subprocess.Popen(
            ["caffeinate", _CAFFEINATE_FLAGS],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return None


def release_display_awake(handle: Optional[subprocess.Popen]) -> None:
    """Stop a :func:`keep_display_awake` assertion (no-op on ``None``)."""
    if handle is None:
        return
    try:
        handle.terminate()
        handle.wait(timeout=5)
    except (OSError, subprocess.SubprocessError):
        try:
            handle.kill()
        except (OSError, subprocess.SubprocessError):
            pass


def bring_app_foreground(pid: int) -> bool:
    """Make the app process ``pid`` the foreground/key application, best-effort.

    WebKit only keeps a page's timers un-throttled while its window is
    foreground-active; the in-app always-on-top pin (#957) keeps the window
    *visible* but does not make the app the *active* application — the terminal
    running pytest is. This asks System Events to set that process frontmost by
    its unix id, which is what un-parks the reconnect engine under automation.

    Returns ``True`` on success. Best-effort: off macOS, on any AppleScript /
    Automation-permission failure, or a missing process, it returns ``False`` and
    the caller carries on (the suite still guards on the runner probe).
    """
    if platform.system() != "Darwin":
        return False
    script = (
        "tell application \"System Events\" to set frontmost of "
        f"(first application process whose unix id is {int(pid)}) to true"
    )
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0
