"""Embedded-services (HTTP/FTP/TFTP) sidebar helpers (issue #947).

Drives the **Services** sidebar — the local HTTP/FTP/TFTP servers gated behind
experimental features. Mirrors :class:`NetworkToolsUi`: an idempotent sidebar
opener plus CRUD/lifecycle helpers that prefer the Zustand store
(``embeddedServers`` / ``embeddedServerStates``) over DOM scraping for state, and
the live ``data-testid``s for interactions.
"""

from __future__ import annotations

import socket
from typing import TYPE_CHECKING, Any, Optional

from .base import HarnessMixin


class EmbeddedServicesUi(HarnessMixin):
    """Open the Services sidebar and create/start/stop/edit embedded servers."""

    # Sidebar + dialog testids.
    ACTIVITY = "activity-bar-services"
    SIDEBAR = "server-sidebar"
    NEW_BTN = "server-new-btn"
    EMPTY = "server-empty-message"
    INDICATOR = "services-indicator"
    DIALOG_NAME = "server-dialog-name"
    DIALOG_ROOT = "server-dialog-root"
    DIALOG_PORT = "server-dialog-port"
    DIALOG_BIND = "server-dialog-bind-host"
    DIALOG_SAVE = "server-dialog-save"
    DIALOG_CANCEL = "server-dialog-cancel"
    LAN_CONFIRM = "lan-warning-confirm"
    LAN_CANCEL = "lan-warning-cancel"

    if TYPE_CHECKING:  # supplied by SettingsUi / SidebarUi when the suite combines them

        def enable_experimental_features(self) -> None: ...
        def _ensure_sidebar(self, view: str, test_id: str) -> None: ...
        def switch_to_connections_sidebar(self) -> None: ...

    # ── Sidebar ──────────────────────────────────────────────────────────────
    def open_services_sidebar(self) -> None:
        """Reveal and show the Services sidebar (idempotent)."""
        self.enable_experimental_features()
        self._ensure_sidebar("services", self.ACTIVITY)
        self.wait(lambda: self.driver.exists(self.SIDEBAR), what="the Services sidebar")

    # ── Store reads ──────────────────────────────────────────────────────────
    def servers(self) -> list[dict[str, Any]]:
        """All configured embedded servers from the store (empty if none)."""
        return self.driver.get_state("embeddedServers") or []

    def find_server(self, name: str) -> Optional[dict[str, Any]]:
        """The server config with the given name, or ``None``."""
        return next((s for s in self.servers() if s.get("name") == name), None)

    def require_server(self, name: str) -> dict[str, Any]:
        """Poll until a server named ``name`` exists; return its config."""
        return self.wait(lambda: self.find_server(name), what=f"the server {name!r}")

    def server_status(self, server_id: str) -> Optional[str]:
        """The runtime status of a server (``running`` / ``stopped`` / …)."""
        states = self.driver.get_state("embeddedServerStates") or {}
        entry = states.get(server_id)
        return entry.get("status") if entry else None

    def server_running(self, server_id: str) -> bool:
        return self.server_status(server_id) == "running"

    # ── Dialog / CRUD ────────────────────────────────────────────────────────
    def open_new_dialog(self) -> None:
        """Open the New Service dialog and wait for its name field."""
        self.open_services_sidebar()
        self.driver.click(self.NEW_BTN)
        self.wait(lambda: self.driver.exists(self.DIALOG_NAME), what="the New Service dialog")

    def fill_dialog(
        self, name: str, *, proto: str = "http", root: str = "/tmp", port: Optional[int] = None
    ) -> None:
        """Fill the (already-open) service dialog. Does not submit."""
        self.driver.type(self.DIALOG_NAME, name)
        self.driver.click(f"server-dialog-proto-{proto}")
        self.driver.type(self.DIALOG_ROOT, root)
        if port is not None:
            self.driver.type(self.DIALOG_PORT, str(port))

    def create_server(
        self, name: str, *, proto: str = "http", root: str = "/tmp", port: Optional[int] = None
    ) -> dict[str, Any]:
        """Create a server through the dialog and return its persisted config."""
        self.open_new_dialog()
        self.fill_dialog(name, proto=proto, root=root, port=port)
        self.driver.click(self.DIALOG_SAVE)
        return self.require_server(name)

    def start_server(self, server_id: str) -> None:
        """Click Start and wait for the server to report ``running``."""
        self.driver.click(f"server-start-{server_id}")
        self.wait(lambda: self.server_running(server_id), what="the server to start")

    def stop_server(self, server_id: str) -> None:
        """Click Stop and wait for the server to leave ``running``."""
        self.driver.click(f"server-stop-{server_id}")
        self.wait(lambda: not self.server_running(server_id), what="the server to stop")

    def delete_server(self, server_id: str, name: str) -> None:
        """Delete a server and wait for it to vanish from the store."""
        self.driver.click(f"server-delete-{server_id}")
        self.wait(lambda: self.find_server(name) is None, what="the server to be deleted")

    # ── Cleanup ──────────────────────────────────────────────────────────────
    def cleanup_all_servers(self) -> None:
        """Stop and delete every embedded server (between-test hygiene)."""
        for server in self.servers():
            server_id, name = server["id"], server["name"]
            if self.server_running(server_id):
                try:
                    self.stop_server(server_id)
                except Exception:  # noqa: BLE001 — best-effort teardown
                    pass
            try:
                self.delete_server(server_id, name)
            except Exception:  # noqa: BLE001 — best-effort teardown
                pass

    # ── Helpers ──────────────────────────────────────────────────────────────
    @staticmethod
    def free_port() -> int:
        """Pick a currently-free localhost TCP port for a server to bind."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]
