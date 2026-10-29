"""Wayland-only X11 forwarding hint under a headless weston (MT-SSH-50, #4965).

On Linux termiHub never installs an X server: it adopts the running one. The
one case where forwarding genuinely needs a package is a Wayland session
without XWayland — the app must say "install XWayland", not a generic "no X
server". The classification is unit-tested from fixtures
(``src-tauri/src/terminal/xserver/linux_gap.rs``); this suite grades it on a
real Wayland-only session.

The suite starts its own headless ``weston`` (no ``--xwayland``) and launches
the test app on it alone: ``GDK_BACKEND=wayland``, ``WAYLAND_DISPLAY`` and
``XDG_SESSION_TYPE=wayland`` set, ``DISPLAY`` unset. It needs a host with no X
server socket in ``/tmp/.X11-unix`` and no ``Xwayland`` on ``PATH``, so CI runs
it in its own step after the Xvfb bulk lane has exited (system-integration.yml,
skip-guard lane ``wayland-linux``). Under Xvfb it skips; that skip is allowlisted
for the bulk lanes in ``skip-allowlist.d/4965-wayland-only-x11-hint.json``.

The other half of the old guided MT-SSH-50 check — a running X server is
adopted without a setup prompt — is graded under Xvfb by
``test_ssh.py::TestSshX11Display::test_running_x_server_is_adopted_without_a_setup_prompt``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator, NamedTuple

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_USERNAME,
    SSH_X11_PORT,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
X11_SOCKET_DIR = Path("/tmp/.X11-unix")

#: The typed Linux Wayland-gap error (types.rs ``linux_xwayland_missing``).
XWAYLAND_MESSAGE = "Wayland session without XWayland"
XWAYLAND_HINT = "XWayland package"
#: The connect-time "X11 forwarding unavailable" toast (#5079).
CONNECT_FAILED_TOAST = "x-server-connect-failed-toast"


class Weston(NamedTuple):
    """A running headless weston: its socket name and runtime dir."""

    socket: str
    runtime_dir: Path


def _x11_sockets() -> list[str]:
    """The X server sockets (``X<N>``) in ``/tmp/.X11-unix``."""
    try:
        entries = list(X11_SOCKET_DIR.iterdir())
    except OSError:
        return []
    return sorted(p.name for p in entries if p.name[:1] == "X" and p.name[1:].isdigit())


def _wayland_only_skip_reason() -> str | None:
    """Why this host cannot present a Wayland-only session, or ``None``."""
    if not sys.platform.startswith("linux"):
        return "the Wayland-only X11 hint grade is Linux-only"
    sockets = _x11_sockets()
    if sockets:
        return (
            "an X server socket is present (/tmp/.X11-unix: "
            f"{', '.join(sockets)}); the Wayland-only grade runs in its own step"
        )
    if shutil.which("Xwayland"):
        return "Xwayland is on PATH; the grade needs a Wayland session without it"
    if shutil.which("weston") is None:
        return "weston is not installed (apt install weston)"
    return None


def _start_weston(runtime_dir: Path, socket: str, log: Path, renderer: list[str]):
    env = {k: v for k, v in os.environ.items() if k not in ("DISPLAY", "WAYLAND_DISPLAY")}
    env["XDG_RUNTIME_DIR"] = str(runtime_dir)
    return subprocess.Popen(
        [
            "weston",
            "--backend=headless",
            *renderer,
            "--no-config",
            "--idle-time=0",
            "--width=1280",
            "--height=800",
            f"--socket={socket}",
            f"--log={log}",
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
    )


@pytest.fixture(scope="class")
def headless_weston() -> Iterator[Weston]:
    """A headless weston without XWayland, private to this suite."""
    reason = _wayland_only_skip_reason()
    if reason:
        pytest.skip(reason)
    runtime_dir = Path(tempfile.mkdtemp(prefix="thub-weston-"))
    runtime_dir.chmod(0o700)
    socket = f"thub-wayland-{os.getpid()}"
    log = runtime_dir / "weston.log"
    proc = None
    # The pixman renderer composites shm buffers like a desktop would; a weston
    # that does not know the flag falls back to its default headless renderer.
    for renderer in (["--renderer=pixman"], []):
        proc = _start_weston(runtime_dir, socket, log, renderer)
        deadline = time.monotonic() + 15.0
        while time.monotonic() < deadline and proc.poll() is None:
            if (runtime_dir / socket).exists():
                break
            time.sleep(0.1)
        if proc.poll() is None and (runtime_dir / socket).exists():
            break
        proc.kill()
        proc.wait(timeout=10)
        proc = None
    if proc is None:
        text = log.read_text(errors="replace") if log.exists() else "(no weston log)"
        shutil.rmtree(runtime_dir, ignore_errors=True)
        pytest.fail(f"headless weston did not create its socket:\n{text[-4000:]}")
    try:
        yield Weston(socket, runtime_dir)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        shutil.rmtree(runtime_dir, ignore_errors=True)


@pytest.mark.usefixtures("ssh_x11_fixtures")
class TestWaylandOnlyX11Hint(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """The app on a Wayland-only session guides the XWayland install."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    unset_app_env = ("DISPLAY",)

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        weston: Weston = request.getfixturevalue("headless_weston")
        return {
            "XDG_RUNTIME_DIR": str(weston.runtime_dir),
            "WAYLAND_DISPLAY": weston.socket,
            "XDG_SESSION_TYPE": "wayland",
            "GDK_BACKEND": "wayland",
        }

    def _app_log_text(self) -> str:
        """The captured app output plus the app's own log files."""
        parts = []
        for path in [self.app.log_path, *sorted(Path(self.app.log_dir).glob("*.log"))]:
            try:
                parts.append(Path(path).read_text(encoding="utf-8", errors="replace"))
            except OSError:
                continue
        return "\n".join(parts)

    def test_x11_connect_on_wayland_only_guides_the_xwayland_install(self):
        """MT-SSH-50: Wayland-only shows the XWayland install hint, not a generic error.

        The app runs on a headless weston without XWayland. An X11-forwarding
        SSH connect still opens a working shell — no setup prompt, no error
        dialog — with no forwarded ``$DISPLAY``, and the connect logs the typed
        XWayland gap and shows it at once in a toast with the package hint and
        an Install XWayland action (#5079). The X server setup flow then shows the XWayland message,
        the package hint and an Install XWayland action, not the generic
        "no X server" error.
        """
        name = unique_name("x11-wayland")
        self.create_ssh_connection(
            name, host=HOST, port=SSH_X11_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.accept_host_key_prompt()
        tab = self.wait(lambda: self.find_tab(name), what="the X11 SSH tab")
        self.wait(self.has_terminal, what="the X11 SSH terminal")

        # Forwarding was skipped gracefully: the shell works, $DISPLAY is empty.
        self.run_command("echo TH_X11_DISPLAY=[$DISPLAY]")
        output = self.wait_for_output("TH_X11_DISPLAY=[]", tab_id=tab["id"])
        assert "TH_X11_DISPLAY=[]" in output
        assert not self.driver.exists("x-server-connect-consent-dialog"), (
            "connecting on Linux must never prompt to install an X server"
        )

        # The connect path classified the gap as Wayland-without-XWayland.
        self.wait(
            lambda: XWAYLAND_MESSAGE in self._app_log_text(),
            timeout=30.0,
            what="the connect to log the typed XWayland gap",
        )
        assert "failed to acquire X server session" not in self._app_log_text(), (
            "the connect reported a generic lease failure instead of the gap"
        )

        # #5079: the connect itself shows the hint — a toast carrying the
        # XWayland message, the package hint and the install action, with no
        # dialog opened and without the user visiting the X server setup.
        self.wait(
            lambda: self.driver.exists(CONNECT_FAILED_TOAST),
            timeout=30.0,
            what="the connect-time X11 forwarding toast",
        )
        toast = self.driver.get_text(CONNECT_FAILED_TOAST)
        assert XWAYLAND_MESSAGE in toast, f"toast lacks the XWayland gap: {toast!r}"
        assert XWAYLAND_HINT in toast, f"toast lacks the install hint: {toast!r}"
        assert "Install XWayland" in toast, f"toast lacks the install action: {toast!r}"
        assert not self.driver.exists("x-server-connect-consent-dialog"), (
            "the connect-time hint must not open a dialog by itself"
        )

        # The X server setup flow shows the actionable XWayland hint.
        self.driver.click("activity-bar-settings")
        self.wait(
            lambda: self.driver.exists("settings-menu-open-connections"),
            what="the settings menu",
        )
        self.driver.click("settings-menu-open-connections")
        self.wait(
            lambda: self.driver.exists("open-connections-x-server-setup"),
            what="the 'No X server' row with its Set up button",
        )
        assert not self.driver.exists("open-connections-x-server-row")
        self.driver.click("open-connections-x-server-setup")
        self.wait(
            lambda: self.driver.exists("x-server-setup-enable"), what="the X server setup consent"
        )
        self.driver.click("x-server-setup-enable")
        self.wait(
            lambda: self.driver.exists("x-server-setup-error"), what="the X server setup error"
        )
        message = self.driver.get_text("x-server-setup-error")
        dialog = self.driver.get_text("x-server-setup-dialog")
        assert XWAYLAND_MESSAGE in message, f"not the XWayland gap: {message!r}"
        assert XWAYLAND_HINT in dialog, f"no XWayland install hint: {dialog!r}"
        assert "Install XWayland" in self.driver.get_text("x-server-setup-install-dep")
        self.driver.click("x-server-setup-close")
        self.dismiss_menu()
        self.close_all_tabs()
