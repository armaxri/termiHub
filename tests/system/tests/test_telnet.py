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

pytestmark = pytest.mark.integration


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
