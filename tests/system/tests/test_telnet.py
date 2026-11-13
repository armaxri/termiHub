"""Telnet infrastructure system tests (ported from tests/e2e/infrastructure/telnet.test.js).

Drives the real app over the test bridge against the Docker telnet container
(``telnet-server`` — ``in.telnetd`` via xinetd, published on 2301). The
``telnet_fixtures`` session fixture brings it up and skips cleanly when no
container runtime is available.

Each ``SystemTest`` subclass gets its own fresh app instance; methods within a
class share it and run in order. Connection names are uniquified so tabs from
earlier methods never alias later ones.
"""

from __future__ import annotations

import sys
import time

import pytest

from termihub_harness import (
    ConnectionsUi,
    SystemTest,
    TabsUi,
    TELNET_HOST,
    TELNET_PORT,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run.telnet_server import (
    PROMPT,
    TelnetServer,
    TelnetUnavailable,
)

pytestmark = pytest.mark.integration

#: The account on the in-test telnet server (a test constant, never a secret).
DROP_USER = "telnet-drop"
DROP_PASSWORD = "telnet-drop-pw"
OVERLAY = "terminal-disconnect-overlay"
RECONNECT_BTN = "terminal-disconnect-reconnect-btn"


@pytest.mark.usefixtures("telnet_fixtures")
class TestTelnetConnect(TerminalUi, TabsUi, ConnectionsUi, SystemTest):
    """TELNET-01: connect to the telnet server and see its banner."""

    def test_connects_and_opens_a_tab(self):
        name = unique_name("telnet-conn")
        self.create_telnet_connection(
            name, host=TELNET_HOST, port=TELNET_PORT, connect=True
        )

        tab = self.wait(lambda: self.find_tab(name), what="the telnet tab to open")
        assert tab is not None
        active = self.active_tab()
        assert active is not None and name in (active.get("title") or "")

    def test_terminal_becomes_live_and_shows_banner(self):
        name = unique_name("telnet-banner")
        self.create_telnet_connection(
            name, host=TELNET_HOST, port=TELNET_PORT, connect=True
        )
        self.wait(lambda: self.find_tab(name), what="the telnet tab")
        # Replaces the old `.xterm` DOM check: a readable terminal session is the
        # bridge-world signal the terminal rendered and is live. Unlike the
        # WebdriverIO suite (which could not read the xterm canvas), the bridge
        # can assert the server actually streamed its login banner back.
        self.wait(self.has_terminal, what="the telnet terminal session")
        output = self.wait_for_output("login:")
        assert "login:" in output


@pytest.mark.usefixtures("telnet_fixtures")
class TestTelnetIo(TerminalUi, ConnectionsUi, SystemTest):
    """TELNET-02: the telnet terminal is interactive (send + receive)."""

    def test_terminal_round_trips_input(self):
        name = unique_name("telnet-io")
        self.create_telnet_connection(
            name, host=TELNET_HOST, port=TELNET_PORT, connect=True
        )
        self.wait(self.has_terminal, what="the telnet terminal session")
        # Wait for the login prompt so the server is ready to read input.
        self.wait_for_output("login:")

        # The original WebdriverIO TELNET-02 only checked that an xterm existed;
        # the bridge can prove the session is interactive end to end: sending a
        # username makes ``login`` advance from "login:" to the "Password:"
        # prompt (the username itself is not echoed by this server).
        self.run_command("testuser")
        assert "Password:" in self.wait_for_output("Password:")


class TestTelnetConnectionFailure(ConnectionsUi, SystemTest):
    """TELNET-03: an unreachable host fails gracefully (no container needed)."""

    def test_unreachable_host_is_handled_gracefully(self):
        name = unique_name("telnet-fail")
        self.create_telnet_connection(
            name,
            host=TELNET_HOST,
            port=19998,  # nothing listening here
            connect=True,
        )
        # The original WebdriverIO test's only real pass condition was "the app
        # does not hang or crash" — assert exactly that: the bridge keeps
        # answering while the connection attempt to a closed port fails fast.
        for _ in range(8):
            assert isinstance(self.driver.get_state(), dict)
            time.sleep(0.25)


@pytest.fixture(scope="class")
def telnet_drop_server(request, tmp_path_factory):
    """An unprivileged loopback telnet server the test can drop server-side.

    The product run's server (:mod:`termihub_harness.product_run.telnet_server`,
    #5574): a real login and ``/bin/sh`` on a pty with a scratch ``HOME`` and no
    history file. Its :meth:`~TelnetServer.drop_all` closes the client sockets
    from the server side, which the Docker ``telnet-server`` fixture cannot do
    for one session without killing ``in.telnetd`` in the container.
    """
    try:
        srv = TelnetServer(
            tmp_path_factory.mktemp("telnet-drop-home"),
            username=DROP_USER,
            password=DROP_PASSWORD,
        )
        srv.start()
    except TelnetUnavailable as exc:
        pytest.fail(f"the in-test telnet server did not start: {exc}")
    request.cls.server = srv
    yield srv
    srv.stop()


@pytest.mark.skipif(
    sys.platform.startswith("win"), reason="the in-test telnet server needs a POSIX pty"
)
@pytest.mark.usefixtures("telnet_drop_server")
class TestTelnetServerDisconnect(TerminalUi, TabsUi, ConnectionsUi, SystemTest):
    """TELNET-04: a server-side close ends the session; Reconnect starts a new one.

    Regression for #5569: the telnet reader used to treat end-of-stream as "no
    data yet", so the tab stayed ``connected`` with no overlay after the server
    closed the connection. Telnet auto-reconnect is off by default (#5390), so
    the drop lands on the manual disconnect overlay without opting out.
    """

    server: TelnetServer

    def _wait_tail(self, tab_id: str, suffix: str, what: str) -> None:
        """Wait until the terminal's last non-blank text ends with ``suffix``.

        The tail, not a plain substring: after Reconnect the scrollback still
        holds the first session's ``login:`` and prompt, which must not satisfy
        the wait for the new session's.
        """
        self.wait(
            lambda: self.driver.read_terminal(tab_id).rstrip().endswith(suffix),
            what=what,
        )

    def _login_and_echo(self, tab_id: str, marker: str) -> None:
        """Log in on the current session and prove the shell runs a command."""
        self._wait_tail(tab_id, "login:", "the telnet login prompt")
        self.driver.terminal_input(f"{DROP_USER}\r", tab_id=tab_id)
        self._wait_tail(tab_id, "Password:", "the telnet password prompt")
        self.driver.terminal_input(f"{DROP_PASSWORD}\r", tab_id=tab_id)
        self.wait(lambda: self.server.latest().logged_in, what="the server to accept the login")
        self._wait_tail(tab_id, PROMPT.strip(), "the telnet shell prompt")
        # Split the marker in the typed command so only the echoed output (not
        # the command line itself) can satisfy the wait.
        head, tail = marker[: len(marker) // 2], marker[len(marker) // 2 :]
        self.driver.terminal_input(f"echo {head}''{tail}\r", tab_id=tab_id)
        self.wait_for_output(marker, tab_id=tab_id)

    def test_server_close_shows_overlay_and_reconnect_restores_session(self):
        srv = self.server
        # The overlay's controls carry no tab id, and an inactive tab keeps its
        # overlay mounted: start from an empty tab strip (see test_ssh.py).
        self.close_all_tabs()

        name = unique_name("telnet-drop")
        self.create_telnet_connection(name, host="127.0.0.1", port=srv.port, connect=True)
        tab_id = self.wait(lambda: self.find_tab(name), what="the telnet tab")["id"]
        self.wait(
            lambda: self.terminal_session_status(tab_id) == "connected",
            what="the telnet tab to report connected",
        )
        self._login_and_echo(tab_id, "TH_TELNET_BEFORE_DROP_5578")

        sessions_before = len(srv.sessions)
        assert srv.drop_all() >= 1, "the server had no client connection to close"

        # The #5569 bug: the tab kept reporting connected after the server left.
        self.wait(
            lambda: self.terminal_session_exited(tab_id),
            timeout=30.0,
            what="the telnet tab to be marked disconnected after the server closed it (#5569)",
        )
        assert self.terminal_session_status(tab_id) != "connected"
        self.wait(lambda: self.driver.exists(OVERLAY), what="the disconnect overlay")
        assert self.driver.exists(RECONNECT_BTN), "the disconnect overlay has no Reconnect button"
        # Disconnect is not tab close: the tab stays so the user can reconnect.
        assert self.find_tab(name) is not None, "the dropped telnet tab was closed"

        self.driver.click(RECONNECT_BTN)
        self.wait(
            lambda: len(srv.sessions) > sessions_before,
            timeout=30.0,
            what="Reconnect to open a new server-side telnet session",
        )
        self.wait(
            lambda: self.terminal_session_status(tab_id) == "connected"
            and not self.driver.exists(OVERLAY),
            timeout=30.0,
            what="the tab to reconnect with the overlay gone",
        )
        self._login_and_echo(tab_id, "TH_TELNET_AFTER_RECONNECT_5578")
