"""Extended SSH infrastructure tests (ported from infrastructure/ssh-extended.test.js).

Covers connecting without X11, that passwords are not persisted to the saved
config, and that a connection is created for tunnel auto-start configuration.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SSH_PASSWORD,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshExtended(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    def test_connects_without_x11(self):
        name = unique_name("ssh-no-x11")
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
        assert self.find_tab(name) is not None

    def test_password_is_not_stored_in_config(self):
        name = unique_name("ssh-no-store")
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
        )
        self.handle_password_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
        # The entered password is used for the session but must never be written
        # into the saved connection config (the bridge-observable form of
        # "stored passwords stripped": reconnecting would prompt again).
        # Read the connections projection region (ConnectionsView twin,
        # {"folders": [...], "connections": [...]}) via find_connection — the
        # get_state("connections") slice was removed in the Phase-5 reducer
        # removal, connections is now region-authoritative (#2626).
        saved = self.wait(lambda: self.find_connection(name), what="connection to load")
        assert saved is not None
        assert SSH_PASSWORD not in str(saved.get("config", {}))

    def test_connection_created_for_tunnel_autostart(self):
        # MT-SSH-34 verified the auto-start config exists; full verification needs
        # an app restart. Here we assert the SSH connection backing it is created.
        name = unique_name("ssh-tunnel-auto")
        self.create_ssh_connection(
            name, host=HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=False
        )
        # Region-authoritative connections read via find_connection (#2626).
        self.wait(lambda: self.find_connection(name), what="connection to save")
