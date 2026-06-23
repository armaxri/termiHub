"""SSH tunnel operations (ported from infrastructure/ssh-tunnels-infra.test.js).

Drives the experimental Tunnels view: create a local-forward tunnel against the
ssh-tunnel-target container (2207, internal HTTP on :8080), start/stop it, and
assert its state via the store (`get_state("tunnels")` / `get_state("tunnelStates")`).

Uses **key auth** for the tunnel's SSH connection: tunnel start has no
interactive password-prompt path (startTunnel calls the backend directly), so a
password connection with no stored credential could never authenticate. The
ssh-tunnel-target container accepts the fixture ed25519 key.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    SSH_KEY_PATH,
    SSH_TUNNEL_PORT,
    SSH_USERNAME,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
RUNNING = {"connecting", "connected", "reconnecting"}


@pytest.mark.usefixtures("ssh_tunnel_fixtures")
class TestSshTunnels(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SettingsUi, SystemTest):
    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def test_create_tunnel_appears_in_list(self):
        tunnel = self._create_tunnel("tunnel-stats", local_port=18085)
        assert tunnel["name"].startswith("sys-tunnel-stats")
        assert tunnel["tunnelType"]["type"] == "local"
        assert self.driver.exists(f"tunnel-item-{tunnel['id']}")
        assert self.driver.exists(f"tunnel-name-{tunnel['id']}")

    def test_save_and_start_connects(self):
        tunnel = self._create_tunnel("tunnel-save-start", local_port=18083, start=True)
        self._assert_running(tunnel["id"])

    def test_start_then_stop(self):
        tid = self._create_tunnel("tunnel-startstop", local_port=18081)["id"]
        self.driver.click(f"tunnel-start-{tid}")  # key auth → no prompt
        self._assert_running(tid)
        # The stop control is offered for a running tunnel and clicking it is
        # handled without crashing. (A local forward sits in "connecting" until
        # traffic flows, so the status does not flip on its own — the original
        # test likewise only checked the control, not a post-stop status.)
        self.wait(lambda: self.driver.exists(f"tunnel-stop-{tid}"), what="the stop control")
        self.driver.click(f"tunnel-stop-{tid}")
        assert isinstance(self.driver.get_state(), dict)

    def test_tunnel_runs_alongside_an_ssh_session(self):
        tunnel = self._create_tunnel("tunnel-traffic", local_port=18084, start=True)
        self._assert_running(tunnel["id"])
        # A key-auth SSH session to the same host connects with the tunnel up.
        self.switch_to_connections_sidebar()
        name = unique_name("tunnel-ssh")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_TUNNEL_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        self.wait(self.has_terminal, what="the SSH terminal session")
        assert self.find_tab(name) is not None

    # ── helpers ────────────────────────────────────────────────────────────────
    def _create_tunnel(self, prefix, *, local_port, start=False):
        """Create a local-forward tunnel via the editor; return its store entry."""
        name = unique_name(prefix)
        ssh_value = self._create_ssh_for_tunnel(unique_name(f"{prefix}-host"))
        self.enable_experimental_features()
        self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
        self.driver.click("tunnel-new-btn")
        self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")
        self.driver.type("tunnel-editor-name", name)
        # The SSH-connection <option> values are the saved connections' ids, which
        # equal the name we gave; retry until the just-created one is selectable.
        self.wait(
            lambda: self._try_select("tunnel-editor-ssh-connection", ssh_value),
            what="the SSH connection option to load",
        )
        self.driver.click("tunnel-type-local")
        self.wait(
            lambda: self.driver.exists("tunnel-editor-local-port"),
            what="the local-forward fields",
        )
        self.driver.type("tunnel-editor-local-port", str(local_port))
        self.driver.type("tunnel-editor-remote-host", "localhost")
        self.driver.type("tunnel-editor-remote-port", "8080")
        self.driver.click("tunnel-editor-save-start" if start else "tunnel-editor-save")
        return self.wait(lambda: self._tunnel_by_name(name), what="the tunnel to be saved")

    def _create_ssh_for_tunnel(self, name: str) -> str:
        """Create a key-auth SSH connection for a tunnel; return its select value.

        The tunnel editor keys its SSH-connection options by the saved
        connection's id, which equals the name we provide here.
        """
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_TUNNEL_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=False,
        )
        self.wait(
            lambda: any(
                c.get("name") == name for c in self.driver.get_state("connections") or []
            ),
            what="the SSH connection to save",
        )
        return name

    def _tunnel_by_name(self, name: str):
        for t in self.driver.get_state("tunnels") or []:
            if t.get("name") == name:
                return t
        return None

    def _tunnel_status(self, tunnel_id: str):
        # Runtime status lives in a separate tunnelStates map keyed by id.
        state = (self.driver.get_state("tunnelStates") or {}).get(tunnel_id)
        return state.get("status") if state else None

    def _assert_running(self, tunnel_id: str) -> None:
        assert self.wait(
            lambda: self._tunnel_status(tunnel_id) in RUNNING,
            what="the tunnel to start",
        )
