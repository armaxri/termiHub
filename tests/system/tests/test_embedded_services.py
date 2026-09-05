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
FTP uses stdlib ``ftplib`` and TFTP uses the maintained ``tftpy`` library
(``termihub_harness.transfers``). These replace the old ``curl`` dependency,
whose TFTP/FTP support is build-dependent and could silently skip SVC-13 on
hosts shipping a ``curl`` without ``tftp://`` (issue #964).
"""

from __future__ import annotations

import shutil
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
from termihub_harness.transfers import (
    TftpUnavailable,
    ftp_download,
    ftp_list,
    tftp_download,
)

pytestmark = pytest.mark.integration


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
        # Directory listing is on by default. Regression for #961: a listed file
        # must still download (it previously 404'd while the index rendered).
        root = self._serve_dir("hello.txt", "termihub-http-ok")
        port = self.free_port()
        server = self.create_server(unique_name("http"), proto="http", root=str(root), port=port)
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

    # ── SVC-10 / SVC-14 / SVC-15: File Browser quick-share (HTTP/FTP/TFTP) ────
    def _quick_share_folder(self, proto: str) -> dict:
        """Quick-share a fresh local folder via ``proto`` and return the server.

        Mirrors the in-app File Browser flow: a local terminal supplies a
        directory, ``context-file-share-<proto>`` switches to the Services sidebar
        and creates+starts a server bound to ``127.0.0.1`` on the protocol's
        default unprivileged port (HTTP 8080 / FTP 2121 / TFTP 6969). Returns the
        started server's store config.
        """
        # A local terminal gives the file browser a directory to share.
        self.ensure_terminal()
        self.open_file_browser()
        folder = unique_name("share")
        self.create_folder_via_browser(folder)

        self.open_file_menu(folder)
        menu_item = f"context-file-share-{proto}"
        self.wait(
            lambda: self.driver.exists(menu_item),
            what=f"the Share via {proto.upper()} menu item",
        )
        self.driver.click(menu_item)

        # Quick-share switches to the Services sidebar and starts a server.
        self.wait(lambda: self.driver.exists(self.SIDEBAR), what="the Services sidebar")
        # Select the server just shared by the unique folder it serves — NOT
        # ``servers()[0]``. The per-test teardown is best-effort, so a server
        # created by an earlier quick-share case can linger in the store; picking
        # index 0 then reads that stale server, and a Share-via-FTP/TFTP assertion
        # sees the leftover HTTP server's ``serverType`` instead of the one just
        # shared. Matching on the folder basename (``unique_name`` per test) ties
        # the result to this test's own share regardless of any leftover.
        server = self.wait(
            lambda: next(
                (s for s in self.servers() if Path(s.get("rootDirectory") or "").name == folder),
                None,
            ),
            what="the shared server",
        )
        self.wait(lambda: self.server_running(server["id"]), what="the shared server to start")
        return server

    def test_quick_share_via_http(self):
        server = self._quick_share_folder("http")
        assert server["serverType"] == "http"

    def test_quick_share_via_ftp(self):
        """SVC-14 — Share via FTP from the File Browser starts an FTP server."""
        server = self._quick_share_folder("ftp")
        assert server["serverType"] == "ftp"

    def test_quick_share_via_tftp(self):
        """SVC-15 — Share via TFTP from the File Browser starts a TFTP server."""
        server = self._quick_share_folder("tftp")
        assert server["serverType"] == "tftp"

    def test_quick_share_ftp_serves_the_folder(self):
        """SVC-14b — the FTP server the quick-share starts actually serves files.

        Drops a file into the shared folder from the terminal, then downloads it
        with the stdlib ``ftplib`` checker against the running quick-share server
        (``127.0.0.1`` on the FTP default port) — verifying a real transfer, not
        just that the server reached ``running``.
        """
        server = self._quick_share_folder("ftp")
        root, port = server["rootDirectory"], server["port"]
        Path(root, "share.txt").write_text("termihub-quickshare-ftp-ok\n", encoding="utf-8")

        downloaded = ftp_download("127.0.0.1", port, "share.txt")
        assert downloaded.decode("utf-8").strip() == "termihub-quickshare-ftp-ok"

    def test_quick_share_tftp_serves_the_folder(self):
        """SVC-15b — the TFTP server the quick-share starts actually serves files.

        Same as the FTP variant but over a real ``tftpy`` RRQ; skipped only if the
        optional ``tftpy`` dependency is missing (never on a host with the harness
        requirements installed).
        """
        server = self._quick_share_folder("tftp")
        root, port = server["rootDirectory"], server["port"]
        Path(root, "boot.txt").write_text("termihub-quickshare-tftp-ok\n", encoding="utf-8")

        try:
            downloaded = tftp_download("127.0.0.1", port, "boot.txt")
        except TftpUnavailable as exc:  # pragma: no cover — only if dep missing
            pytest.skip(str(exc))
        assert downloaded.decode("utf-8").strip() == "termihub-quickshare-tftp-ok"

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

    # ── SVC-12: FTP actual file transfer (stdlib ftplib) ─────────────────────
    def test_ftp_file_transfer(self):
        root = self._serve_dir("hello.txt", "termihub-ftp-transfer-ok\n")
        port = self.free_port()
        server = self.create_server(unique_name("ftp"), proto="ftp", root=str(root), port=port)
        self.start_server(server["id"])

        # stdlib ftplib is always available, so the download is verified on every
        # host (no host-curl-build dependency).
        downloaded = ftp_download("127.0.0.1", port, "hello.txt")
        assert downloaded.decode("utf-8").strip() == "termihub-ftp-transfer-ok"

        names = ftp_list("127.0.0.1", port, "/")
        assert any(
            Path(n).name == "hello.txt" for n in names
        ), "FTP directory listing should include the file"

    # ── SVC-13: TFTP actual file transfer (tftpy RRQ) ────────────────────────
    def test_tftp_file_transfer(self):
        root = self._serve_dir("boot.txt", "termihub-tftp-transfer-ok\n")
        port = self.free_port()
        server = self.create_server(unique_name("tftp"), proto="tftp", root=str(root), port=port)
        self.start_server(server["id"])

        # tftpy performs a real RRQ, so this is verified everywhere the harness
        # deps are installed — never silently skipped on a curl without tftp://.
        try:
            downloaded = tftp_download("127.0.0.1", port, "boot.txt")
        except TftpUnavailable as exc:  # pragma: no cover — only if dep missing
            pytest.skip(str(exc))
        assert downloaded.decode("utf-8").strip() == "termihub-tftp-transfer-ok"

    # ── SVC-16: per-server context menu — start / stop ───────────────────────
    def test_context_menu_start_and_stop(self):
        """The right-click menu's Start/Stop drive the same lifecycle as the
        inline buttons. The menu swaps Start↔Stop with running state, so this
        exercises both menu items on one server."""
        server = self.create_server(unique_name("ctx"), proto="http", port=self.free_port())
        self.ctx_start_server(server["id"])
        assert self.server_running(server["id"]), "ctx Start should start the server"
        self.ctx_stop_server(server["id"])
        assert not self.server_running(server["id"]), "ctx Stop should stop the server"

    # ── SVC-17: per-server context menu — delete ─────────────────────────────
    def test_context_menu_delete(self):
        """The right-click menu's Delete removes the server (and, as the last one,
        restores the empty state)."""
        name = unique_name("ctx-del")
        server = self.create_server(name, proto="http", port=self.free_port())
        self.ctx_delete_server(server["id"], name)
        assert self.find_server(name) is None, "ctx Delete should remove the server"
        assert self.driver.exists(self.EMPTY), "empty-state should return after deleting the last server"

    # ── SVC-18: per-server context menu — copy URL ───────────────────────────
    def test_context_menu_copy_url(self):
        """Copy URL is always present in the menu and selectable without error.

        The action writes to the OS clipboard via a Tauri plugin (best-effort,
        swallowing failures), so the clipboard contents are not asserted here —
        the check is that the item exists and the menu closes after selecting it.
        """
        server = self.create_server(unique_name("ctx-url"), proto="http", port=self.free_port())
        self.open_server_menu(server["id"])
        assert self.driver.exists(f"ctx-copy-url-{server['id']}")
        self.driver.click(f"ctx-copy-url-{server['id']}")
        self.wait(
            lambda: not self.driver.exists(f"ctx-copy-url-{server['id']}"),
            what="the context menu to close after Copy URL",
        )

    # ── SVC-19: per-server context menu — Open in Browser (HTTP only) ─────────
    def test_context_menu_open_in_browser_http_only(self):
        """``Open in Browser`` is offered for HTTP servers and absent for FTP.

        Selecting it opens the URL via a Tauri opener plugin (best-effort); we
        assert the item is present for HTTP, selectable, and that the menu closes —
        and that the item is *not* rendered for a non-HTTP (FTP) server.
        """
        http = self.create_server(unique_name("ctx-http"), proto="http", port=self.free_port())
        self.open_server_menu(http["id"])
        assert self.driver.exists(f"ctx-open-browser-{http['id']}"), "HTTP should offer Open in Browser"
        self.driver.click(f"ctx-open-browser-{http['id']}")
        self.wait(
            lambda: not self.driver.exists(f"ctx-open-browser-{http['id']}"),
            what="the context menu to close after Open in Browser",
        )

        ftp = self.create_server(unique_name("ctx-ftp"), proto="ftp", port=self.free_port())
        self.open_server_menu(ftp["id"])
        assert not self.driver.exists(
            f"ctx-open-browser-{ftp['id']}"
        ), "Open in Browser must not be offered for non-HTTP servers"
