"""Embedded Services suite (SVC-01..13) on the Python bridge harness (issue #947).

Ports ``tests/e2e/embedded-services.test.js`` — the local HTTP/FTP/TFTP servers
(formerly gated behind experimental features, always on since #5858) — onto the bridge harness (part of #803 /
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

import json
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

    def reset_before_rerun(self) -> None:
        # The per-test teardown cleans servers and tabs best-effort, but cannot get
        # past a delete confirm or an unsaved-changes prompt that a failed attempt
        # left open. Close those, then retry the cleanup (#4834).
        self.dismiss_modals("server-delete-confirm", "unsaved-changes-just-close")
        self.open_services_sidebar()
        self.cleanup_all_servers()

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

    # ── SVC-02: New file server editor (open, cancel, create HTTP) ───────────────
    def test_new_editor_opens_and_cancels(self):
        self.open_new_editor()
        assert self.driver.exists(self.DIALOG_NAME)
        self.driver.click(self.DIALOG_CANCEL)
        self.wait(lambda: not self.driver.exists(self.DIALOG_NAME), what="the editor to close")
        assert self.driver.exists(self.EMPTY), "cancel must not create a server"

    def test_create_http_server(self):
        name = unique_name("http")
        server = self.create_server(name, proto="http", port=self.free_port())
        assert self.driver.exists(f"server-item-{server['id']}")
        # The protocol is in the row's tooltip, not on the row (#5770).
        tip = self.driver.get_attribute(f"server-item-{server['id']}", "aria-description") or ""
        assert tip.startswith("HTTP · http://"), tip

    # ── SVC-03: start / stop HTTP + it actually responds ─────────────────────
    def test_start_and_stop_http_server(self):
        server = self.create_server(unique_name("http"), proto="http", port=self.free_port())
        self.start_server(server["id"])
        assert self.driver.exists(f"server-stop-{server['id']}")
        self.stop_server(server["id"])
        assert not self.server_running(server["id"])

    def test_activity_says_what_happened(self):
        """The Activity of a server keeps each change, the newest first (#6028, slice 9)."""
        server = self.create_server(unique_name("http"), proto="http", port=self.free_port())
        self.start_server(server["id"])
        self.open_server_activity(server["id"])
        self.wait(
            lambda: self.driver.get_text(self.ACTIVITY_STATE).strip() == "Running" or None,
            what="Activity to say Running",
        )
        self.wait(
            lambda: any("Running" in line for line in self.activity_events()) or None,
            what="Running in what happened",
        )
        self.driver.click("service-activity-action-stop")
        self.wait(lambda: not self.server_running(server["id"]), what="the server to stop")
        events = self.wait(
            lambda: (lambda e: e if e and "Stopped" in e[0] else None)(self.activity_events()),
            what="Stopped on top of what happened",
        )
        assert any("Running" in line for line in events[1:]), events

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
        self.wait(lambda: self.driver.exists(self.DIALOG_NAME), what="the editor")
        assert self.driver.get_value(self.DIALOG_NAME) == name, "the editor should pre-populate"

        renamed = unique_name("renamed")
        self.driver.type(self.DIALOG_NAME, renamed)
        self.driver.click(self.DIALOG_SAVE)
        self.require_server(renamed)
        assert self.find_server(name) is None, "old name should be gone after rename"

    # ── SVC-06: duplicate ────────────────────────────────────────────────────
    def test_duplicate_server(self):
        name = unique_name("dup")
        server = self.create_server(name, proto="http", port=self.free_port())
        self.open_server_menu(server["id"])
        self.driver.click(f"ctx-duplicate-{server['id']}")
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
        tip = self.driver.get_attribute(f"server-item-{server['id']}", "aria-description") or ""
        assert tip.startswith(f"{badge} · {proto}://"), tip
        self.start_server(server["id"])
        assert self.server_running(server["id"])

    # ── SVC-10 / SVC-14 / SVC-15: File Browser quick-share (HTTP/FTP/TFTP) ────
    def _quick_share_folder(self, proto: str) -> dict:
        """Quick-share a fresh local folder via ``proto`` and return the server.

        Mirrors the in-app File Browser flow: a local terminal supplies a
        directory, ``context-file-share-<proto>`` opens the editor with the folder
        for this session, and Save and start starts it on this computer only (on a
        free port near the protocol's default). Returns the started server's store
        config.
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

        # The share opens the editor (#6028, slice 12): who and what, for this
        # session; a device server starts with nobody chosen.
        self.wait(lambda: self.driver.exists(self.DIALOG_NAME), what="the share's editor")
        assert self.driver.get_attribute("server-dialog-temporary", "aria-checked") == "true"
        if self.driver.get_attribute(self.BIND_HERE, "aria-checked") != "true":
            self.driver.click(self.BIND_HERE)
        self.driver.click("server-dialog-save-start")
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

    # ── SVC-11: who can open it + the warning whenever others can ─────────────
    def test_open_to_the_network_warns(self):
        self.open_new_editor()
        assert self.driver.get_attribute(self.BIND_HERE, "aria-checked") == "true"
        assert not self.driver.exists(self.WARNING), "nobody else can open it yet"
        self.driver.click(self.BIND_NETWORK)
        self.wait(lambda: self.driver.exists(self.WARNING), what="the warning")
        # Unsaved changes are asked about.
        self.driver.click(self.DIALOG_CANCEL)
        self.wait(
            lambda: self.driver.exists("unsaved-changes-just-close"), what="the unsaved prompt"
        )
        self.driver.click("unsaved-changes-just-close")
        self.wait(lambda: not self.driver.exists(self.DIALOG_NAME), what="the editor to close")

    def test_open_to_the_network_is_saved(self):
        name = unique_name("bind-all")
        self.open_new_editor()
        self.fill_editor(name, port=self.free_port())
        self.driver.click(self.BIND_NETWORK)
        self.driver.click(self.DIALOG_SAVE)

        server = self.require_server(name)
        assert server.get("bindHost") == "0.0.0.0"
        assert server.get("readOnly") is True, "a new server is download only"

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

    # ── SVC-18: per-server context menu — copy address ───────────────────────────
    def test_context_menu_copy_url(self):
        """Copy address is in the menu while the server runs (#6028), and selectable
        without error; a stopped server has no address.

        The action writes to the OS clipboard via a Tauri plugin (best-effort,
        swallowing failures), so the clipboard contents are not asserted here —
        the check is that the item exists and the menu closes after selecting it.
        """
        server = self.create_server(unique_name("ctx-url"), proto="http", port=self.free_port())
        assert not self.driver.exists(f"server-address-{server['id']}")
        self.start_server(server["id"])
        self.wait(
            lambda: self.driver.exists(f"server-address-{server['id']}"),
            what="the address of the running server",
        )
        assert self.driver.get_text(f"server-address-{server['id']}").startswith(
            "http://localhost:"
        )
        self.open_server_menu(server["id"])
        assert self.driver.exists(f"ctx-copy-url-{server['id']}")
        self.driver.click(f"ctx-copy-url-{server['id']}")
        self.wait(
            lambda: not self.driver.exists(f"ctx-copy-url-{server['id']}"),
            what="the context menu to close after Copy address",
        )

    # ── SVC-19: per-server context menu — Open in Browser (HTTP only) ─────────
    def test_context_menu_open_in_browser_http_only(self):
        """``Open in Browser`` is offered for HTTP servers and absent for FTP.

        Selecting it opens the URL via a Tauri opener plugin (best-effort); we
        assert the item is present for HTTP, selectable, and that the menu closes —
        and that the item is *not* rendered for a non-HTTP (FTP) server.
        """
        http = self.create_server(unique_name("ctx-http"), proto="http", port=self.free_port())
        self.start_server(http["id"])
        self.open_server_menu(http["id"])
        assert self.driver.exists(f"ctx-open-browser-{http['id']}"), "HTTP should offer Open in Browser"
        self.driver.click(f"ctx-open-browser-{http['id']}")
        self.wait(
            lambda: not self.driver.exists(f"ctx-open-browser-{http['id']}"),
            what="the context menu to close after Open in Browser",
        )

        ftp = self.create_server(unique_name("ctx-ftp"), proto="ftp", port=self.free_port())
        self.start_server(ftp["id"])
        self.open_server_menu(ftp["id"])
        assert not self.driver.exists(
            f"ctx-open-browser-{ftp['id']}"
        ), "Open in Browser must not be offered for non-HTTP servers"

    # ── SVC-20: auto-start on application launch (legacy manual MT-SVC-06) ─────
    def test_auto_start_server_runs_after_app_restart(self):
        """A server saved with "Auto-start when termiHub launches" is running —
        and actually serving — after a kill/relaunch, without a Start click.

        Replaces the legacy manual item MT-SVC-06 (#3681).
        """
        root = self._serve_dir("auto.txt", "termihub-autostart-ok")
        port = self.free_port()
        name = unique_name("auto")
        self.open_new_editor()
        self.fill_editor(name, root=str(root), port=port)
        self.driver.click("server-dialog-autostart")
        self.driver.click(self.DIALOG_SAVE)
        server = self.require_server(name)
        assert server.get("autoStart") is True, "the auto-start flag must persist"

        self.restart_app()
        self.wait(lambda: self.server_running(server["id"]), what="the auto-started server")
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/auto.txt", timeout=10) as resp:
            assert resp.read().decode("utf-8").strip() == "termihub-autostart-ok"

    # ── SVC-21: a server set to an agent never falls back to this computer ─────
    def test_a_server_of_a_missing_agent_is_not_started_here(self):
        """A stored agent that is gone means not started, with the reason on the
        row, and no port on this computer (#6028)."""
        root = self._serve_dir("agent.txt", "termihub-must-not-be-served")
        port = self.free_port()
        name = unique_name("on-agent")
        self.open_new_editor()
        self.fill_editor(name, root=str(root), port=port)
        self.driver.click("server-dialog-autostart")
        self.driver.click(self.DIALOG_SAVE)
        server = self.require_server(name)

        def set_agent() -> None:
            path = self.config_dir / "embedded_servers.json"
            doc = json.loads(path.read_text(encoding="utf-8"))
            for entry in doc["servers"]:
                if entry["id"] == server["id"]:
                    entry["host"] = {"kind": "agent", "agentId": "agent-that-is-gone"}
            path.write_text(json.dumps(doc), encoding="utf-8")

        def refused():
            states = self.driver.get_state("embeddedServerStates") or {}
            state = states.get(server["id"], {})
            return state if state.get("status") == "error" else None

        self.restart_app(set_agent)
        self.open_services_sidebar()
        state = self.wait(refused, what="the refused start")
        assert "the agent it runs on was removed" in (state.get("error") or "")
        assert "removed" in self.driver.get_text(f"server-item-{server['id']}")
        with pytest.raises(OSError):
            urllib.request.urlopen(f"http://127.0.0.1:{port}/agent.txt", timeout=2)
