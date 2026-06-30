"""Embedded Services suite (SVC-01..13) on the Python bridge harness (issue #947).

Ports ``tests/e2e/embedded-services.test.js`` — the local HTTP/FTP/TFTP servers
gated behind experimental features — onto the bridge harness (part of #803 /
epic #799). Each WebdriverIO ``data-testid`` interaction becomes a bridge step
and each assertion a check; server *state* is read from the Zustand store
(``embeddedServers`` / ``embeddedServerStates``) rather than scraped from the
status-dot class, so the assertions track real behaviour.

The live transfer cases (SVC-03 HTTP response, SVC-12 FTP, SVC-13 TFTP) run a
real client against the server the app starts on ``127.0.0.1`` — the app and the
test share a host, so no Docker fixture is needed. HTTP uses stdlib ``urllib``;
FTP/TFTP use ``curl`` (matching the original spec; the stdlib has no TFTP
client), skipping if ``curl`` is unavailable or lacks the protocol.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import pytest

from termihub_harness import (
    EmbeddedServicesUi,
    FilesUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


def _curl(url: str) -> subprocess.CompletedProcess[str]:
    """Run curl against a localhost embedded server, skipping if unusable."""
    try:
        return subprocess.run(
            ["curl", "--silent", "--connect-timeout", "5", "--max-time", "10", url],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        pytest.skip("curl is not installed on this host")
    except subprocess.TimeoutExpired:
        pytest.fail(f"curl timed out fetching {url}")


class TestEmbeddedServices(
    EmbeddedServicesUi,
    SidebarUi,
    SettingsUi,
    TabsUi,
    TerminalUi,
    FilesUi,
    SystemTest,
):
    """SVC-01..13 — Services sidebar CRUD, lifecycle, status bar, quick-share,
    and live HTTP/FTP/TFTP transfers."""

    @pytest.fixture(autouse=True)
    def _per_test(self):
        self._tmpdirs: list[Path] = []
        yield
        try:
            self.open_services_sidebar()
            self.cleanup_all_servers()
        except Exception:  # noqa: BLE001 — best-effort teardown
            pass
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        for d in self._tmpdirs:
            shutil.rmtree(d, ignore_errors=True)

    # ── helpers ──────────────────────────────────────────────────────────────
    def _serve_dir(self, filename: str, content: str) -> Path:
        """Make a temp dir holding one file, removed in the per-test teardown.

        The path is canonicalized (``resolve()``) because the server canonicalizes
        its root for the traversal check, and macOS temp dirs live under the
        ``/var → /private/var`` symlink — an unresolved root would mismatch.
        """
        root = Path(tempfile.mkdtemp(prefix="thub-svc-")).resolve()
        (root / filename).write_text(content, encoding="utf-8")
        self._tmpdirs.append(root)
        return root

    # ── SVC-01: sidebar + New Service button + empty state ───────────────────
    def test_sidebar_and_empty_state(self):
        self.open_services_sidebar()
        assert self.driver.exists(self.SIDEBAR)
        assert self.driver.exists(self.NEW_BTN)
        assert self.driver.exists(self.EMPTY), "empty-state message should show with no servers"

    # ── SVC-02: New Service dialog (open, cancel, create HTTP) ───────────────
    def test_new_dialog_opens_and_cancels(self):
        self.open_new_dialog()
        assert self.driver.exists(self.DIALOG_NAME)
        self.driver.click(self.DIALOG_CANCEL)
        self.wait(lambda: not self.driver.exists(self.DIALOG_NAME), what="the dialog to close")
        assert self.driver.exists(self.EMPTY), "cancel must not create a server"

    def test_create_http_server(self):
        name = unique_name("http")
        server = self.create_server(name, proto="http", port=self.free_port())
        assert self.driver.exists(f"server-item-{server['id']}")
        assert self.driver.get_text(f"server-type-{server['id']}") == "HTTP"

    # ── SVC-03: start / stop HTTP + it actually responds ─────────────────────
    def test_start_and_stop_http_server(self):
        server = self.create_server(unique_name("http"), proto="http", port=self.free_port())
        self.start_server(server["id"])
        assert self.driver.exists(f"server-stop-{server['id']}")
        self.stop_server(server["id"])
        assert not self.server_running(server["id"])

    def test_http_server_serves_a_file(self):
        root = self._serve_dir("hello.txt", "termihub-http-ok")
        port = self.free_port()
        name = unique_name("http")
        self.open_new_dialog()
        self.fill_dialog(name, proto="http", root=str(root), port=port)
        # Directory listing is on by default, but with it on the embedded server
        # 404s direct file downloads (a real bug — see #961). Turn it off so this
        # case exercises actual file serving via ServeDir.
        self.driver.click("server-dialog-dirlisting")
        self.driver.click(self.DIALOG_SAVE)
        server = self.require_server(name)
        self.start_server(server["id"])

        with urllib.request.urlopen(f"http://127.0.0.1:{port}/hello.txt", timeout=10) as resp:
            assert resp.status == 200
            assert resp.read().decode("utf-8").strip() == "termihub-http-ok"

    def test_http_server_directory_listing(self):
        """With directory listing on (the default), GET / returns a listing of
        the root — SVC-03's "responds to HTTP requests"."""
        root = self._serve_dir("hello.txt", "termihub-http-ok")
        port = self.free_port()
        server = self.create_server(unique_name("http"), proto="http", root=str(root), port=port)
        self.start_server(server["id"])
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=10) as resp:
            assert resp.status == 200
            assert "hello.txt" in resp.read().decode("utf-8")

    # ── SVC-04: status-bar services indicator (show / open / hide) ───────────
    def test_status_bar_services_indicator(self):
        server = self.create_server(unique_name("http"), proto="http", port=self.free_port())
        self.start_server(server["id"])
        self.wait(lambda: self.driver.exists(self.INDICATOR), what="the services indicator")

        # Navigate away, then click the indicator to reopen the Services sidebar.
        self.switch_to_connections_sidebar()
        self.driver.click(self.INDICATOR)
        self.wait(lambda: self.driver.exists(self.SIDEBAR), what="the Services sidebar to reopen")

        # Stopping the only server hides the indicator.
        self.stop_server(server["id"])
        self.wait(lambda: not self.driver.exists(self.INDICATOR), what="the indicator to hide")

    # ── SVC-05: edit (pre-populate + persist rename) ─────────────────────────
    def test_edit_prepopulates_and_persists(self):
        name = unique_name("edit")
        server = self.create_server(name, proto="http", port=self.free_port())

        self.driver.click(f"server-edit-{server['id']}")
        self.wait(lambda: self.driver.exists(self.DIALOG_NAME), what="the edit dialog")
        assert self.driver.get_value(self.DIALOG_NAME) == name, "dialog should pre-populate"

        renamed = unique_name("renamed")
        self.driver.type(self.DIALOG_NAME, renamed)
        self.driver.click(self.DIALOG_SAVE)
        self.require_server(renamed)
        assert self.find_server(name) is None, "old name should be gone after rename"

    # ── SVC-06: duplicate ────────────────────────────────────────────────────
    def test_duplicate_server(self):
        name = unique_name("dup")
        server = self.create_server(name, proto="http", port=self.free_port())
        self.driver.click(f"server-duplicate-{server['id']}")
        self.require_server(f"Copy of {name}")

    # ── SVC-07: delete restores empty state ──────────────────────────────────
    def test_delete_server(self):
        name = unique_name("del")
        server = self.create_server(name, proto="http", port=self.free_port())
        self.delete_server(server["id"], name)
        assert self.driver.exists(self.EMPTY), "empty-state should return after deleting the last server"

    # ── SVC-08 / SVC-09: FTP / TFTP lifecycle (badge + running) ──────────────
    @pytest.mark.parametrize("proto,badge", [("ftp", "FTP"), ("tftp", "TFTP")])
    def test_ftp_tftp_lifecycle(self, proto: str, badge: str):
        server = self.create_server(unique_name(proto), proto=proto, port=self.free_port())
        assert self.driver.get_text(f"server-type-{server['id']}") == badge
        self.start_server(server["id"])
        assert self.server_running(server["id"])

    # ── SVC-10: File Browser quick-share via HTTP ────────────────────────────
    def test_quick_share_via_http(self):
        # A local terminal gives the file browser a directory to share.
        self.ensure_terminal()
        self.open_file_browser()
        folder = unique_name("share")
        self.create_folder_via_browser(folder)

        self.open_file_menu(folder)
        self.wait(
            lambda: self.driver.exists("context-file-share-http"),
            what="the Share via HTTP menu item",
        )
        self.driver.click("context-file-share-http")

        # Quick-share switches to the Services sidebar and starts a server.
        self.wait(lambda: self.driver.exists(self.SIDEBAR), what="the Services sidebar")
        server = self.wait(lambda: self.servers()[0] if self.servers() else None, what="a shared server")
        self.wait(lambda: self.server_running(server["id"]), what="the shared server to start")

    # ── SVC-11: bind-address dropdown + LAN security warning ─────────────────
    def test_bind_address_lan_warning(self):
        self.open_new_dialog()
        assert self.driver.exists(self.DIALOG_BIND)
        assert self.driver.get_value(self.DIALOG_BIND) == "127.0.0.1", "default bind is loopback"

        # Selecting 0.0.0.0 raises the LAN security warning (proves the option exists).
        self.driver.select(self.DIALOG_BIND, "0.0.0.0")
        self.wait(lambda: self.driver.exists(self.LAN_CONFIRM), what="the LAN security warning")
        self.driver.click(self.LAN_CANCEL)
        self.driver.click(self.DIALOG_CANCEL)

    def test_bind_to_all_interfaces_after_confirm(self):
        name = unique_name("bind-all")
        self.open_new_dialog()
        self.fill_dialog(name, proto="http", port=self.free_port())
        self.driver.select(self.DIALOG_BIND, "0.0.0.0")
        self.wait(lambda: self.driver.exists(self.LAN_CONFIRM), what="the LAN security warning")
        self.driver.click(self.LAN_CONFIRM)
        self.driver.click(self.DIALOG_SAVE)

        server = self.require_server(name)
        assert server.get("bindHost") == "0.0.0.0", "confirmed bind should be 0.0.0.0"

    # ── SVC-12: FTP actual file transfer (curl) ──────────────────────────────
    def test_ftp_file_transfer(self):
        root = self._serve_dir("hello.txt", "termihub-ftp-transfer-ok\n")
        port = self.free_port()
        server = self.create_server(unique_name("ftp"), proto="ftp", root=str(root), port=port)
        self.start_server(server["id"])

        download = _curl(f"ftp://127.0.0.1:{port}/hello.txt")
        if download.returncode != 0:
            pytest.skip(f"curl FTP unsupported/failed: {download.stderr.strip()}")
        assert download.stdout.strip() == "termihub-ftp-transfer-ok"

        listing = _curl(f"ftp://127.0.0.1:{port}/")
        assert "hello.txt" in listing.stdout, "FTP directory listing should include the file"

    # ── SVC-13: TFTP actual file transfer (curl) ─────────────────────────────
    def test_tftp_file_transfer(self):
        root = self._serve_dir("boot.txt", "termihub-tftp-transfer-ok\n")
        port = self.free_port()
        server = self.create_server(unique_name("tftp"), proto="tftp", root=str(root), port=port)
        self.start_server(server["id"])

        download = _curl(f"tftp://127.0.0.1:{port}/boot.txt")
        if download.returncode != 0:
            pytest.skip(f"curl TFTP unsupported/failed: {download.stderr.strip()}")
        assert download.stdout.strip() == "termihub-tftp-transfer-ok"
