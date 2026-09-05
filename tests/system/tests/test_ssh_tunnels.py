"""SSH tunnel operations (ported from ssh-tunnels.test.js + ssh-tunnels-infra).

Drives the experimental Tunnels view. Two kinds of coverage:

* **Editor / list UI** (TUNNEL-01..06, 08..10): open the sidebar and editor,
  check each tunnel type's diagram + form fields, edit/duplicate/delete a saved
  tunnel. These assert on the live DOM (`get_text` / `get_value`) and the store,
  and need no running SSH server.
* **Live tunnel** (TUNNEL-07 + start/stop): create a local-forward tunnel against
  the ssh-tunnel-target container (2207, internal HTTP on :8080), start/stop it,
  and assert its state via the store (`get_state("tunnels")` /
  `get_state("tunnelStates")`).

Uses **key auth** for the tunnel's SSH connection: tunnel start has no
interactive password-prompt path (startTunnel calls the backend directly), so a
password connection with no stored credential could never authenticate. The
ssh-tunnel-target container accepts the fixture ed25519 key.

Reaches parity with the WebdriverIO `ssh-tunnels.test.js` (TUNNEL-01..10), which
this suite replaces (#810).
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

from termihub_harness import dev_local

#: Local-forward listen ports are offset per checkout (parallel isolation).
_TUNNEL_OFFSET = dev_local.port_offset()

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
RUNNING = {"connecting", "connected", "reconnecting"}

# macOS Docker Desktop runs containers inside a Linux VM, so — unlike Linux Docker
# (host networking) — the host-native app's russh local-forward to the published
# SSH port never drives the live tunnel to a running state in this harness, and
# the three tests that actually *start* a tunnel time out (#933). The editor/list
# tests (TUNNEL-01..10) need no running tunnel and stay enabled everywhere; only
# the live-start tests are gated, and they keep running in the Linux
# integration-fixtures CI lane. This mirrors the E2E tauri-driver macOS carve-out
# (ADR-5): macOS-specific behaviour is verified via the manual steps in
# docs/testing.md instead.
LIVE_TUNNEL_SKIP_REASON = (
    "Live SSH tunnels time out on macOS Docker Desktop (containers run in a Linux "
    "VM without host networking); covered by Linux CI + manual macOS steps (#933)."
)
skip_live_tunnel_on_macos = pytest.mark.skipif(
    "sys.platform == 'darwin'", reason=LIVE_TUNNEL_SKIP_REASON
)


@pytest.mark.usefixtures("ssh_tunnel_fixtures")
class TestSshTunnels(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SettingsUi, SystemTest):
    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── Editor / list UI (no live SSH server needed) ────────────────────────────
    def test_sidebar_shows_new_tunnel_button(self):
        """TUNNEL-01: the tunnels sidebar renders with the New Tunnel button."""
        self.enable_experimental_features()
        self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
        self.wait(lambda: self.driver.exists("tunnel-new-btn"), what="the tunnels sidebar")
        assert self.driver.exists("tunnel-sidebar")

    def test_editor_opens_with_all_fields(self):
        """TUNNEL-02: New Tunnel opens an editor with name, SSH select, type
        buttons, the diagram, and a "New SSH Tunnel" title."""
        self._open_new_tunnel_editor()
        fields = (
            "tunnel-editor-name",
            "tunnel-editor-ssh-connection",
            "tunnel-type-local",
            "tunnel-type-remote",
            "tunnel-type-dynamic",
            "tunnel-diagram",
        )
        self.wait(
            lambda: all(self.driver.exists(t) for t in fields),
            what="the tunnel editor fields",
        )
        assert "New SSH Tunnel" in self.driver.get_text("tunnel-editor-title")

    def test_local_type_shows_forward_diagram_and_fields(self):
        """TUNNEL-03: Local forward — Your PC → SSH Server → Target, with both
        local-bind and remote-target host/port fields."""
        self._open_new_tunnel_editor()
        self.driver.click("tunnel-type-local")
        self.wait(
            lambda: self.driver.exists("tunnel-editor-local-port"),
            what="the local-forward fields",
        )
        diagram = self.driver.get_text("tunnel-diagram")
        for token in ("Your PC", "SSH Server", "Target"):
            assert token in diagram, token
        form = self.driver.get_text("tunnel-editor-form")
        for label in ("Local Host", "Local Port", "Remote Host", "Remote Port"):
            assert label in form, label

    def test_remote_type_shows_reverse_diagram_and_fields(self):
        """TUNNEL-04: Remote forward — Local Target → SSH Server → Remote Clients."""
        self._open_new_tunnel_editor()
        self.driver.click("tunnel-type-remote")
        self.wait(
            lambda: "Remote Clients" in self.driver.get_text("tunnel-diagram"),
            what="the reverse-forward diagram",
        )
        diagram = self.driver.get_text("tunnel-diagram")
        for token in ("Local Target", "SSH Server", "Remote Clients"):
            assert token in diagram, token
        form = self.driver.get_text("tunnel-editor-form")
        for label in ("Local Host", "Local Port", "Remote Host", "Remote Port"):
            assert label in form, label

    def test_dynamic_type_hides_remote_fields(self):
        """TUNNEL-05: Dynamic (SOCKS5) — Your PC → SSH Server → Internet, with
        only the local-bind fields (no remote host/port)."""
        self._open_new_tunnel_editor()
        self.driver.click("tunnel-type-dynamic")
        self.wait(
            lambda: "Internet" in self.driver.get_text("tunnel-diagram"),
            what="the dynamic-forward diagram",
        )
        diagram = self.driver.get_text("tunnel-diagram")
        for token in ("Your PC", "SSH Server", "Internet"):
            assert token in diagram, token
        form = self.driver.get_text("tunnel-editor-form")
        assert "Local Host" in form and "Local Port" in form
        assert "Remote Host" not in form
        assert "Remote Port" not in form

    def test_diagram_updates_on_local_port_change(self):
        """TUNNEL-06: the diagram reacts to the local-port input."""
        self._open_new_tunnel_editor()
        self.driver.click("tunnel-type-local")
        self.wait(
            lambda: self.driver.exists("tunnel-editor-local-port"),
            what="the local-forward fields",
        )
        self.driver.type("tunnel-editor-local-port", "9191")
        self.wait(
            lambda: "9191" in self.driver.get_text("tunnel-diagram"),
            what="the diagram to reflect the new local port",
        )

    def test_create_tunnel_appears_in_list(self):
        """TUNNEL-07: a saved tunnel shows up in the sidebar list."""
        tunnel = self._create_tunnel("tunnel-stats", local_port=18085 + _TUNNEL_OFFSET)
        assert tunnel["name"].startswith("sys-tunnel-stats")
        assert tunnel["tunnelType"]["type"] == "local"
        assert self.driver.exists(f"tunnel-item-{tunnel['id']}")
        assert self.driver.exists(f"tunnel-name-{tunnel['id']}")

    def test_double_click_opens_editor_for_edit(self):
        """TUNNEL-08: double-clicking a tunnel reopens the editor pre-filled."""
        tunnel = self._create_tunnel("tunnel-edit", local_port=18086 + _TUNNEL_OFFSET)
        self.driver.double_click(f"tunnel-item-{tunnel['id']}")
        self.wait(
            lambda: self.driver.exists("tunnel-editor-name"),
            what="the tunnel editor to reopen",
        )
        self.wait(
            lambda: self.driver.get_value("tunnel-editor-name") == tunnel["name"],
            what="the name field to pre-fill",
        )
        title = self.driver.get_text("tunnel-editor-title")
        assert "Edit Tunnel" in title
        assert tunnel["name"] in title

    def test_duplicate_creates_a_copy(self):
        """TUNNEL-09: Duplicate makes a "Copy of <name>" tunnel."""
        tunnel = self._create_tunnel("tunnel-dup", local_port=18087 + _TUNNEL_OFFSET)
        self.wait(
            lambda: self.driver.exists(f"tunnel-duplicate-{tunnel['id']}"),
            what="the duplicate control",
        )
        self.driver.click(f"tunnel-duplicate-{tunnel['id']}")
        assert self.wait(
            lambda: self._tunnel_by_name(f"Copy of {tunnel['name']}"),
            what="the duplicated tunnel",
        )

    def test_delete_removes_tunnel(self):
        """TUNNEL-10: Delete removes the tunnel from the store and the list."""
        tunnel = self._create_tunnel("tunnel-del", local_port=18088 + _TUNNEL_OFFSET)
        tid = tunnel["id"]
        self.wait(
            lambda: self.driver.exists(f"tunnel-delete-{tid}"),
            what="the delete control",
        )
        self.driver.click(f"tunnel-delete-{tid}")
        assert self.wait(
            lambda: self._tunnel_by_name(tunnel["name"]) is None,
            what="the tunnel to be removed from the store",
        )
        assert not self.driver.exists(f"tunnel-item-{tid}")

    # ── Live tunnel (needs the ssh-tunnel-target container) ──────────────────────

    @skip_live_tunnel_on_macos
    def test_save_and_start_connects(self):
        tunnel = self._create_tunnel("tunnel-save-start", local_port=18083 + _TUNNEL_OFFSET, start=True)
        self._assert_running(tunnel["id"])

    @skip_live_tunnel_on_macos
    def test_start_then_stop(self):
        tid = self._create_tunnel("tunnel-startstop", local_port=18081 + _TUNNEL_OFFSET)["id"]
        self.driver.click(f"tunnel-start-{tid}")  # key auth → no prompt
        self._assert_running(tid)
        # Stop must take effect: the status returns to "disconnected" and the
        # start control comes back. Previously a Stop click while the tunnel was
        # still in "connecting" was silently lost (#829).
        self.wait(lambda: self.driver.exists(f"tunnel-stop-{tid}"), what="the stop control")
        self.driver.click(f"tunnel-stop-{tid}")
        self._assert_disconnected(tid)
        self.wait(
            lambda: self.driver.exists(f"tunnel-start-{tid}"),
            what="the start control to return",
        )

    @skip_live_tunnel_on_macos
    def test_tunnel_runs_alongside_an_ssh_session(self):
        tunnel = self._create_tunnel("tunnel-traffic", local_port=18084 + _TUNNEL_OFFSET, start=True)
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
    def _open_new_tunnel_editor(self):
        """Open a fresh tunnel editor (no SSH connection / save needed)."""
        self.enable_experimental_features()
        self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
        self.driver.click("tunnel-new-btn")
        self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")

    def _create_tunnel(self, prefix, *, local_port, start=False):
        """Create a local-forward tunnel via the editor; return its store entry."""
        name = unique_name(prefix)
        ssh_value = self._create_ssh_for_tunnel(unique_name(f"{prefix}-host"))
        self._open_new_tunnel_editor()
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
        # Region-authoritative connections read via find_connection (the
        # get_state("connections") slice was removed in the Phase-5 reducer
        # removal; the ConnectionsView twin region is authoritative) — #2626.
        self.wait(
            lambda: self.find_connection(name) is not None,
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

    def _assert_disconnected(self, tunnel_id: str) -> None:
        assert self.wait(
            lambda: self._tunnel_status(tunnel_id) == "disconnected",
            what="the tunnel to stop",
        )
