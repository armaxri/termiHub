"""SSH tunnel operations (ported from ssh-tunnels.test.js + ssh-tunnels-infra).

Drives the experimental Tunnels view. Three kinds of coverage:

* **Editor / list UI** (TUNNEL-01..06, 08..10): open the sidebar and editor,
  check each tunnel type's diagram + form fields, edit/duplicate/delete a saved
  tunnel. These assert on the live DOM (`get_text` / `get_value`) and the store,
  and need no running SSH server.
* **Live tunnel** (TUNNEL-07 + start/stop): create a local-forward tunnel, start
  and stop it, and assert its state via the store (`get_state("tunnels")` /
  `get_state("tunnelStates")`) — and that the forward really carries traffic
  (an HTTP GET through the local port returns ``TUNNEL_TEST_OK``).
* **Per-connection port forwards** (PROD-023, #3449): a forward bound to its SSH
  connection with "start with connection" comes up when a terminal to that
  connection connects, is not restarted by a second terminal, and stays down once
  the flag is turned off.

**Tunnel target** (see :func:`tunnel_target`): on Linux (and Windows, where the
Docker fixtures exist) the ssh-tunnel-target container (2207, internal HTTP on
:8080). On **macOS** there is no usable container path — Docker Desktop runs
containers in a Linux VM without host networking, so the host-native app's
forward to a published port never comes up (#933), and the hosted macOS runners
have no container runtime at all — so the suite points at the **native loopback
sshd** instead (``scripts/internal/native-sshd-fixture.sh`` when provisioned,
else a throwaway ``LocalAgentSshd``, both via ``local_agent_endpoint``) and an
in-process HTTP server answering ``TUNNEL_TEST_OK`` (#4005).

Uses **key auth** for the tunnel's SSH connection: tunnel start has no
interactive password-prompt path (startTunnel calls the backend directly), so a
password connection with no stored credential could never authenticate.

Reaches parity with the WebdriverIO `ssh-tunnels.test.js` (TUNNEL-01..10), which
this suite replaces (#810).
"""

from __future__ import annotations

import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler

import pytest

from termihub_harness import (
    ConnectionsUi,
    LocalThreadingHTTPServer,
    SSH_KEY_PATH,
    SSH_TUNNEL_PORT,
    SSH_USERNAME,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    local_agent_endpoint,
    unique_name,
)
from termihub_harness import dev_local
from termihub_harness.local_agent import LocalAgentUnavailable

#: Local-forward listen ports are offset per checkout (parallel isolation).
_TUNNEL_OFFSET = dev_local.port_offset()

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"
#: What the forwarded HTTP service answers (the ssh-tunnel-target container's
#: :8080 server, or :class:`_TunnelOkHandler` on the native-sshd path).
TUNNEL_OK = "TUNNEL_TEST_OK"
#: macOS runs the live tests against the native loopback sshd, not Docker (#933).
USE_NATIVE_SSHD = sys.platform == "darwin"


@dataclass(frozen=True)
class TunnelTarget:
    """Where the suite's tunnels connect and what they forward to."""

    #: SSH server (always on :data:`HOST`).
    ssh_port: int
    username: str
    key_path: str
    #: Forward destination, as seen from the SSH server.
    remote_host: str
    remote_port: int


class _TunnelOkHandler(BaseHTTPRequestHandler):
    """Answers every GET like the ssh-tunnel-target container's :8080 server."""

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        body = f"{TUNNEL_OK}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture(scope="session")
def tunnel_target(request):
    """The SSH server + forward destination the live tunnel tests use.

    macOS: the native loopback sshd (the provisioned fixture when present, else a
    throwaway ``LocalAgentSshd``) plus an in-process HTTP server on a free
    loopback port — the sshd forwards to it on 127.0.0.1. Elsewhere: the
    ssh-tunnel-target container (skips cleanly without a container runtime).
    Session-scoped so it resolves — and skips — before the class's app launches.
    """
    if not USE_NATIVE_SSHD:
        request.getfixturevalue("ssh_tunnel_fixtures")
        yield TunnelTarget(SSH_TUNNEL_PORT, SSH_USERNAME, str(SSH_KEY_PATH), "localhost", 8080)
        return
    try:
        endpoint = local_agent_endpoint(require_agent=False)
        if not endpoint.is_listening():
            endpoint.start()
    except LocalAgentUnavailable as exc:
        pytest.skip(f"native loopback sshd unavailable: {exc}")
    http = LocalThreadingHTTPServer((HOST, 0), _TunnelOkHandler)
    server = threading.Thread(target=http.serve_forever, daemon=True)
    server.start()
    try:
        yield TunnelTarget(
            endpoint.port, endpoint.username, endpoint.client_key_path, HOST, http.server_port
        )
    finally:
        http.shutdown()
        http.server_close()
        endpoint.cleanup()


def _http_get(port: int) -> str:
    """GET ``http://127.0.0.1:<port>/`` (a local-forward listen port); "" on failure."""
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/", timeout=5) as resp:
            return resp.read().decode("utf-8", "replace")
    except (OSError, urllib.error.URLError):
        return ""


@pytest.mark.usefixtures("tunnel_target")
class TestSshTunnels(TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SettingsUi, SystemTest):
    @pytest.fixture(autouse=True)
    def _bind_target(self, tunnel_target):
        self.target = tunnel_target

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

    # ── Live tunnel (needs the tunnel target: container, or native sshd on macOS) ─

    def test_save_and_start_connects(self):
        port = 18083 + _TUNNEL_OFFSET
        tunnel = self._create_tunnel("tunnel-save-start", local_port=port, start=True)
        self._assert_connected(tunnel["id"])
        self._assert_forwards(port)

    def test_start_then_stop(self):
        port = 18081 + _TUNNEL_OFFSET
        tid = self._create_tunnel("tunnel-startstop", local_port=port)["id"]
        self.driver.click(f"tunnel-start-{tid}")  # key auth → no password prompt
        self._assert_connected(tid)
        self._assert_forwards(port)
        # Stop must take effect: the status returns to "disconnected", the start
        # control comes back and the listen port is closed. Previously a Stop
        # click while the tunnel was still in "connecting" was silently lost (#829).
        self.wait(lambda: self.driver.exists(f"tunnel-stop-{tid}"), what="the stop control")
        self.driver.click(f"tunnel-stop-{tid}")
        self._assert_disconnected(tid)
        self.wait(
            lambda: self.driver.exists(f"tunnel-start-{tid}"),
            what="the start control to return",
        )
        assert self.wait(
            lambda: TUNNEL_OK not in _http_get(port), what="the forward to stop serving"
        )

    def test_tunnel_runs_alongside_an_ssh_session(self):
        port = 18084 + _TUNNEL_OFFSET
        tunnel = self._create_tunnel("tunnel-traffic", local_port=port, start=True)
        self._assert_connected(tunnel["id"])
        # A key-auth SSH session to the same host connects with the tunnel up.
        self.switch_to_connections_sidebar()
        name = unique_name("tunnel-ssh")
        self.create_ssh_connection(
            name,
            host=HOST,
            port=self.target.ssh_port,
            username=self.target.username,
            auth_method="key",
            key_path=self.target.key_path,
            connect=True,
        )
        self._wait_live_terminal()
        assert self.find_tab(name) is not None
        self._assert_forwards(port)

    # ── Per-connection port forwards (PROD-023, #3449) ───────────────────────────

    def test_per_connection_forward_follows_terminal_sessions(self):
        """A forward flagged "start with connection" comes up with the first
        terminal to its connection, survives a second terminal untouched, and —
        once stopped and unflagged — stays down when another terminal connects."""
        port = 18089 + _TUNNEL_OFFSET
        conn = self._create_ssh_for_tunnel(unique_name("pf-host"))
        tid = self._create_tunnel(
            "pf-forward", local_port=port, ssh_value=conn, start_with_connection=True
        )["id"]
        assert self._tunnel_by_id(tid)["startWithConnection"] is True
        # Bound, not started: saving alone brings nothing up.
        assert self._tunnel_status(tid) in (None, "disconnected")
        assert TUNNEL_OK not in _http_get(port)

        # First terminal to the connection → the forward comes up and carries traffic.
        self._open_terminal_to(conn)
        self._assert_connected(tid)
        self._assert_forwards(port)
        self.wait(
            lambda: self._tunnel_stats(tid).get("totalConnections", 0) >= 1,
            what="the tunnel stats to count the forwarded request",
        )

        # Second terminal → no restart: the tunnel never leaves "connected" and its
        # per-run stats (reset by a restart) keep counting.
        self._open_terminal_to(conn)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            assert self._tunnel_status(tid) == "connected", "the 2nd terminal restarted it"
            time.sleep(0.25)
        assert self._tunnel_stats(tid).get("totalConnections", 0) >= 1
        self._assert_forwards(port)

        # Stop it and turn "start with connection" off → a new terminal leaves it down.
        self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
        self.wait(lambda: self.driver.exists(f"tunnel-stop-{tid}"), what="the stop control")
        self.driver.click(f"tunnel-stop-{tid}")
        self._assert_disconnected(tid)
        self._set_start_with_connection(tid, False)
        self._open_terminal_to(conn)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            assert self._tunnel_status(tid) in (None, "disconnected"), "unflagged forward started"
            time.sleep(0.25)
        assert TUNNEL_OK not in _http_get(port)

    # ── helpers ────────────────────────────────────────────────────────────────
    def _open_new_tunnel_editor(self):
        """Open a fresh tunnel editor (no SSH connection / save needed)."""
        self.enable_experimental_features()
        self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
        self.driver.click("tunnel-new-btn")
        self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")

    def _create_tunnel(
        self, prefix, *, local_port, start=False, ssh_value=None, start_with_connection=False
    ):
        """Create a local-forward tunnel via the editor; return its store entry.

        ``ssh_value`` reuses an existing SSH connection (else a fresh one is made);
        ``start_with_connection`` flips the editor's "start when a session to this
        SSH connection opens" switch on (it defaults off for a new tunnel).
        """
        name = unique_name(prefix)
        if ssh_value is None:
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
        self.driver.type("tunnel-editor-remote-host", self.target.remote_host)
        self.driver.type("tunnel-editor-remote-port", str(self.target.remote_port))
        if start_with_connection:
            self._set_editor_start_with_connection(True)
        self.driver.click("tunnel-editor-save-start" if start else "tunnel-editor-save")
        return self.wait(lambda: self._tunnel_by_name(name), what="the tunnel to be saved")

    def _set_editor_start_with_connection(self, on: bool) -> None:
        """Flip the open editor's "start with connection" switch to ``on``."""
        toggle = "tunnel-editor-start-with-connection"
        self.wait(lambda: self.driver.exists(toggle), what="the start-with-connection switch")
        if (self.driver.get_attribute(toggle, "aria-checked") == "true") != on:
            self.driver.click(toggle)
        self.wait(
            lambda: (self.driver.get_attribute(toggle, "aria-checked") == "true") == on,
            what="the start-with-connection switch to flip",
        )

    def _set_start_with_connection(self, tunnel_id: str, on: bool) -> None:
        """Reopen a saved tunnel's editor, set the flag, and save."""
        self.driver.double_click(f"tunnel-item-{tunnel_id}")
        self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")
        self._set_editor_start_with_connection(on)
        self.driver.click("tunnel-editor-save")
        self.wait(
            lambda: (self._tunnel_by_id(tunnel_id) or {}).get("startWithConnection") is on,
            what="the start-with-connection flag to save",
        )

    def _create_ssh_for_tunnel(self, name: str) -> str:
        """Create a key-auth SSH connection to the tunnel target; return its id.

        The tunnel editor keys its SSH-connection options by the saved
        connection's id, which equals the name we provide here.
        """
        self.switch_to_connections_sidebar()
        self.create_ssh_connection(
            name,
            host=HOST,
            port=self.target.ssh_port,
            username=self.target.username,
            auth_method="key",
            key_path=self.target.key_path,
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

    def _open_terminal_to(self, connection: str) -> None:
        """Open one more terminal to a saved connection (sidebar double-click)."""
        self.switch_to_connections_sidebar()
        before = self.tab_count()
        self.connect_connection(connection)
        self.wait(lambda: self.tab_count() > before, what="the new terminal tab")
        self._wait_live_terminal()

    def _wait_live_terminal(self) -> None:
        """Wait for the active SSH terminal to really run a shell.

        Answers a host-key trust prompt (#1959) on the way — the fresh app has
        not seen the target's key — then round-trips a marker through the shell,
        since a mounted xterm alone does not prove the session connected.
        """
        self.wait(self.has_terminal, what="the SSH terminal session")
        marker = unique_name("tunnel-echo")

        def echoed() -> bool:
            self._accept_host_key_if_prompted()
            if not self.driver.read_terminal().strip():
                return False
            self.driver.terminal_input(f"echo {marker}")
            return True

        self.wait(echoed, what="the SSH shell to accept input")
        self.wait_for_output(marker)

    def _accept_host_key_if_prompted(self) -> None:
        if self.driver.exists("ssh-hostkey-prompt"):
            self.driver.click("ssh-hostkey-accept-remember")

    def _tunnel_by_name(self, name: str):
        for t in self.driver.get_state("tunnels") or []:
            if t.get("name") == name:
                return t
        return None

    def _tunnel_by_id(self, tunnel_id: str):
        for t in self.driver.get_state("tunnels") or []:
            if t.get("id") == tunnel_id:
                return t
        return None

    def _tunnel_state(self, tunnel_id: str) -> dict:
        # Runtime status lives in a separate tunnelStates map keyed by id.
        return (self.driver.get_state("tunnelStates") or {}).get(tunnel_id) or {}

    def _tunnel_status(self, tunnel_id: str):
        return self._tunnel_state(tunnel_id).get("status")

    def _tunnel_stats(self, tunnel_id: str) -> dict:
        return self._tunnel_state(tunnel_id).get("stats") or {}

    def _assert_connected(self, tunnel_id: str) -> None:
        """Wait for the tunnel to reach "connected" (not just "connecting").

        Answers a host-key trust prompt the tunnel's handshake raises on the way:
        a tunnel start is as much an SSH connect as a terminal's (#1959).
        """

        def connected() -> bool:
            self._accept_host_key_if_prompted()
            status = self._tunnel_status(tunnel_id)
            assert status != "error", self._tunnel_state(tunnel_id)
            return status == "connected"

        assert self.wait(connected, what="the tunnel to connect")

    def _assert_forwards(self, port: int) -> None:
        """The local-forward port carries a real request to the target service."""
        assert self.wait(
            lambda: TUNNEL_OK in _http_get(port), what=f"{TUNNEL_OK} through 127.0.0.1:{port}"
        )

    def _assert_disconnected(self, tunnel_id: str) -> None:
        assert self.wait(
            lambda: self._tunnel_status(tunnel_id) == "disconnected",
            what="the tunnel to stop",
        )
