"""SSH infrastructure system tests (ported from tests/e2e/infrastructure/ssh.test.js).

Drives the real app over the test bridge against the Docker SSH containers
(``ssh-password`` on 2201, ``ssh-keys`` on 2203). The ``ssh_fixtures`` session
fixture brings those containers up and skips cleanly when Docker is unavailable.

Each ``SystemTest`` subclass gets its own fresh app instance; methods within a
class share it and run in order. Connection names are uniquified so tabs from
earlier methods never alias later ones.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
    MonitoringUi,
    PasswordPromptUi,
    SSH_KEYS_PORT,
    SSH_KEY_PATH,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SSH_X11_PORT,
    SshServerControl,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshPasswordAuth(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-01: password authentication opens a working terminal tab."""

    # Live SSH connect: the WKWebView JS thread is starved by the always-on
    # Docker/krunkit VMs during negotiation, so raise the command timeout (#2460).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def test_connects_with_password_and_opens_a_tab(self):
        name = unique_name("ssh-pass")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="password",
            connect=True,
        )
        self.handle_password_prompt()

        tab = self.wait(lambda: self.find_tab(name), what="the SSH tab to open")
        assert tab is not None
        active = self.active_tab()
        assert active is not None and name in (active.get("title") or "")

    def test_terminal_becomes_live_after_connect(self):
        name = unique_name("ssh-live")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        self.wait(lambda: self.find_tab(name), what="the SSH tab")
        # Replaces the old `.xterm` DOM check: a readable terminal session is the
        # bridge-world signal that the terminal rendered and is live.
        self.wait(self.has_terminal, what="the SSH terminal session")


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshPasswordPromptFlow(TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-PASSWORD: the password-prompt modal gates the connection."""

    def test_prompt_appears_on_connect(self):
        name = unique_name("ssh-prompt")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            auth_method="password",
            connect=True,
        )
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the password prompt",
        )
        assert self.password_prompt_open()
        self.cancel_password_prompt()

    def test_cancel_does_not_open_a_tab(self):
        before = self.tab_count()
        name = unique_name("ssh-cancel")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the password prompt",
        )
        self.cancel_password_prompt()
        self.wait(lambda: not self.password_prompt_open(), what="the prompt to close")
        assert self.tab_count() == before

    def test_connects_after_entering_password(self):
        name = unique_name("ssh-enter")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        assert self.wait(lambda: self.find_tab(name), what="the SSH tab")


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshKeyAuth(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-02: key-based authentication connects without a password prompt."""

    def test_connects_with_key_and_opens_a_tab(self):
        if not SSH_KEY_PATH.exists():
            pytest.skip(f"SSH key fixture missing: {SSH_KEY_PATH}")
        name = unique_name("ssh-key")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_KEYS_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        # Key auth must not raise a password prompt.
        tab = self.wait(lambda: self.find_tab(name), what="the SSH key-auth tab")
        assert tab is not None
        assert not self.password_prompt_open()
        self.wait(self.has_terminal, what="the SSH terminal session")


class TestSshConnectionFailure(ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-03: an unreachable host fails gracefully (no Docker needed)."""

    def test_unreachable_host_is_handled_gracefully(self):
        name = unique_name("ssh-fail")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=19999,  # nothing listening here
            username=SSH_USERNAME,
            connect=True,
        )
        # Save & Connect raises the password prompt before connecting; provide the
        # password, then the TCP connection to a closed localhost port fails fast
        # (connection refused). The original WebdriverIO test's only real pass
        # condition was "the app does not hang or crash" — assert exactly that.
        self.handle_password_prompt()
        for _ in range(8):
            assert isinstance(self.driver.get_state(), dict)
            time.sleep(0.25)
        # The prompt must not be left stuck open after the failed attempt.
        assert not self.password_prompt_open()


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshSessionOutput(TerminalUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-05: the SSH terminal is interactive and streams command output."""

    def test_terminal_echoes_command_output(self):
        name = unique_name("ssh-output")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")

        marker = "SYS_SSH_OUTPUT_OK"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshMonitoring(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, MonitoringUi, SystemTest):
    """SSH-08: monitoring shows on an SSH tab and hides on a local tab."""

    def test_monitoring_tracks_the_active_tab(self):
        ssh_name = unique_name("ssh-mon")
        self.create_ssh_connection(
            ssh_name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        ssh_tab = self.wait(lambda: self.find_tab(ssh_name), what="the SSH tab")

        # Monitoring is shown while the SSH tab is active.
        assert self.wait(
            self.monitoring_visible, what="monitoring to appear on the SSH tab"
        )

        # Open a local shell tab — it becomes active and monitoring hides.
        self.driver.click("terminal-view-new-terminal")
        self.wait(self.has_terminal, what="the local terminal")
        assert self.wait(
            lambda: not self.monitoring_visible(),
            what="monitoring to hide on the local tab",
        )

        # Switch back to the SSH tab — monitoring reappears.
        self.switch_to_tab(ssh_tab["id"])
        assert self.wait(
            self.monitoring_visible, what="monitoring to reappear on the SSH tab"
        )


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestSshServerDisconnect(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """SSH-06: a mid-session server-side disconnect surfaces the disconnect UX.

    The WebdriverIO suite left this unimplemented because stopping the shared
    ``ssh-password`` container mid-test would break the sibling SSH suites that
    share it. Instead of touching the container, :class:`SshServerControl` kills
    only the single sshd session *this* test opened — identified by diffing the
    session-PID set around the connect — so the container keeps serving every
    other suite untouched (#1650). The abrupt ``SIGKILL`` (not a clean logout) is
    a genuine server-side drop, so the client classifies it as a dropped session
    (``terminal-exit`` with ``reason: "dropped"``) and shows the disconnect
    overlay rather than entering the calmer clean-exit / view-mode path.
    """

    # Live SSH connect + disconnect: raise the command timeout to ride out the
    # WKWebView JS-thread starvation under the always-on Docker/krunkit VMs (#2460).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def _connect_and_drop(self, name: str, *, marker: str | None = None) -> str:
        """Connect a password SSH tab, optionally echo ``marker``, then drop it.

        Returns the tab id once the client has marked the session exited and the
        disconnect overlay is up.
        """
        control = SshServerControl()
        if not control.available:
            pytest.skip("no container runtime to drop the SSH session server-side")

        # Baseline sshd sessions before this test connects, so the session this
        # connection spawns can be isolated by set difference and killed alone.
        pids_before = control.session_pids()

        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=SSH_USERNAME,
            # Auto-Reconnect is on by default (PARITY-008); this scenario verifies
            # the manual disconnect overlay, so opt out of the automatic redrive.
            auto_reconnect=False,
            connect=True,
        )
        self.handle_password_prompt()
        # Trust the server's host key so the handshake completes — otherwise the
        # #1959 prompt blocks it and no server-side session is ever created (#2447).
        self.accept_host_key_prompt()
        tab = self.wait(lambda: self.find_tab(name), what="the SSH tab")
        self.wait(self.has_terminal, what="the SSH terminal session")
        tab_id = tab["id"]

        if marker is not None:
            # Split the marker in the typed command so only the echoed output (not
            # the command line itself) can satisfy the wait.
            head, tail = marker[: len(marker) // 2], marker[len(marker) // 2 :]
            self.run_command(f"echo {head}''{tail}")
            self.wait_for_output(marker, tab_id=tab_id)

        # Drop *only* this connection's sshd session at the server. The server-side
        # sshd session process appears asynchronously *after* the client initiates
        # the connection, and ``has_terminal`` above only proves the xterm mounted
        # and is readable — which happens while the tab is still ``terminalConnecting``,
        # a moment before the SSH handshake registers the session on the server. A
        # single-shot read therefore raced and saw an empty diff (#2447); poll until
        # the new session PID appears instead.
        new_pids = self.wait(
            lambda: (control.session_pids() - pids_before) or False,
            what="a new sshd session for the SSH connection",
        )
        control.kill_sessions(new_pids)

        # The client must surface the disconnect: the tab's session is marked
        # exited and the disconnect overlay (offering a reconnect) appears.
        self.wait(
            lambda: self.driver.get_state("terminalExitedTabs").get(tab_id) is True,
            what="the SSH tab to be marked disconnected",
        )
        self.wait(
            lambda: self.driver.exists("terminal-disconnect-overlay"),
            what="the disconnect overlay",
        )
        return tab_id

    def test_handles_server_disconnect(self):
        name = unique_name("ssh-disconnect")
        self._connect_and_drop(name)

        # This is the reconnect/error UX the scenario exists to verify — not
        # weakened to a bare "did not crash" check.
        assert self.driver.exists("terminal-disconnect-overlay")
        assert self.driver.exists("terminal-disconnect-reconnect-btn")

        # A dropped session must leave the tab in place (disconnect ≠ tab closed),
        # so the user can read the scrollback and reconnect.
        assert self.find_tab(name) is not None

    # ── MT-SSH-24 / MT-SSH-25: view mode after a server-side drop ────────────
    def test_view_mode_keeps_scrollback_and_enter_offers_reconnect(self):
        marker = "TH_VIEWMODE_SCROLLBACK_4417"
        tab_id = self._connect_and_drop(unique_name("ssh-viewmode"), marker=marker)

        # MT-SSH-24: "View Scrollback" dismisses the overlay into view mode — a
        # thin "Session ended" banner — and the earlier output is still in the
        # buffer (the drop must not wipe the scrollback).
        self.driver.click("terminal-disconnect-view-btn")
        self.wait(
            lambda: not self.driver.exists("terminal-disconnect-overlay"),
            what="the disconnect overlay to close",
        )
        self.wait(
            lambda: self.driver.exists("terminal-view-mode-banner"),
            what="the view-mode banner",
        )
        assert "Session ended" in self.driver.get_text("terminal-view-mode-banner")
        assert marker in self.driver.read_terminal(tab_id), (
            "view mode must keep the pre-disconnect scrollback"
        )

        # MT-SSH-25: Enter in view mode offers a reconnect instead of typing into
        # the dead session. xterm only handles keydown on its hidden input, which
        # the terminal tags per tab for the bridge.
        terminal_input = f"terminal-input-{tab_id}"
        self.driver.press_key("Enter", terminal_input)
        self.wait(
            lambda: self.driver.exists("terminal-reconnect-prompt"),
            what="the reconnect prompt after Enter in view mode",
        )
        assert "Would you like to reconnect?" in self.driver.get_text(
            "terminal-reconnect-prompt"
        )
        assert self.driver.exists("terminal-reconnect-prompt-reconnect-btn")

        # "Stay in View Mode" closes the prompt and leaves the tab in view mode.
        self.driver.click("terminal-reconnect-prompt-stay-btn")
        self.wait(
            lambda: not self.driver.exists("terminal-reconnect-prompt"),
            what="the reconnect prompt to close",
        )
        assert self.driver.exists("terminal-view-mode-banner")
        assert marker in self.driver.read_terminal(tab_id)

        # Enter again re-offers it; "Reconnect" starts a fresh session in the tab.
        self.driver.press_key("Enter", terminal_input)
        self.wait(
            lambda: self.driver.exists("terminal-reconnect-prompt"),
            what="the reconnect prompt a second time",
        )
        self.driver.click("terminal-reconnect-prompt-reconnect-btn")

        def reconnected() -> bool:
            # The credential may or may not be re-requested; answer it if asked.
            if self.password_prompt_open():
                self.handle_password_prompt()
            return (
                self.driver.get_state("terminalExitedTabs").get(tab_id) is not True
                and not self.driver.exists("terminal-reconnect-prompt")
                and not self.driver.exists("terminal-view-mode-banner")
            )

        self.wait(reconnected, what="the tab to reconnect to a fresh session")
        self.run_command("echo TH_RECON''NECTED_OK")
        self.wait_for_output("TH_RECONNECTED_OK", tab_id=tab_id)


def _local_x_server_available() -> bool:
    """Whether the host running the app has a local X server to forward to.

    termiHub only injects ``DISPLAY`` into the remote shell when its X11
    forwarder starts, which needs a local X server (an Xvfb/Xorg display on
    Linux, XQuartz on macOS). Without one the connect degrades gracefully (no
    ``DISPLAY``; covered headlessly by ``core/tests/ssh_x11.rs``), so the
    DISPLAY assertion below is only meaningful where a server exists.
    """
    if sys.platform == "win32":
        return False
    if os.environ.get("DISPLAY"):
        return True
    x11_dir = Path("/tmp/.X11-unix")
    return x11_dir.is_dir() and any(p.name.startswith("X") for p in x11_dir.iterdir())


@pytest.mark.usefixtures("ssh_x11_fixtures")
class TestSshX11Display(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """MT-SSH-16: an X11-forwarding SSH session gets a forwarded ``$DISPLAY``.

    Moved out of the guided-manual ``test_external_app.py`` X11 test: the
    ``ssh-x11`` fixture ships ``X11Forwarding yes`` + ``xauth``, so a session
    opened with X11 forwarding on (the SSH default) must export
    ``DISPLAY=localhost:N.0`` in the remote shell — no operator needed. Only the
    "an X window appears" step stays manual.
    """

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def test_x11_session_sets_forwarded_display(self):
        if not _local_x_server_available():
            pytest.skip("no local X server to forward to (DISPLAY unset, no /tmp/.X11-unix)")

        name = unique_name("x11-display")
        # SSH connections default X11 forwarding ON (test_ssh_x11_defaults_on),
        # so the default form is what negotiates forwarding here.
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_X11_PORT,
            username=SSH_USERNAME,
            connect=True,
        )
        self.handle_password_prompt()
        self.accept_host_key_prompt()
        tab = self.wait(lambda: self.find_tab(name), what="the X11 SSH tab")
        self.wait(self.has_terminal, what="the X11 SSH terminal")

        # A unique marker keeps the typed command line ('$DISPLAY') from matching
        # before the echoed value does.
        self.run_command("echo TH_X11_DISPLAY=$DISPLAY")
        output = self.wait_for_output("TH_X11_DISPLAY=localhost:", tab_id=tab["id"])
        assert "TH_X11_DISPLAY=localhost:" in output, (
            "no forwarded $DISPLAY in the remote shell — X11 forwarding was not "
            "negotiated"
        )


# SSH-07 (X11 forwarding) was left unimplemented in the WebdriverIO suite because
# it needs an X server on the host; automated end-to-end X11 forwarding is instead
# covered by core/tests/ssh_x11.rs (a fake loopback X server, no host display).
@pytest.mark.skip(
    reason="needs an X server on the host (SSH-07); automated end-to-end X11 "
    "forwarding is instead covered by core/tests/ssh_x11.rs, which uses a fake "
    "loopback X server and needs no host display (issue #1304)"
)
def test_forwards_x11_applications():
    ...
