"""The app's Linux delayed-render clipboard owners, read by a second client (#5170).

"Copy to clipboard" in a remote desktop's clipboard panel puts the files the
remote copied on the host clipboard with **delayed rendering**
(``src-tauri/src/linux_clipboard``): the app owns the X11 ``CLIPBOARD``
selection and, on a Wayland session, a ``wlr-data-control`` source. No byte
moves on copy; a paste fetches the files and answers with their ``file://``
URIs. A wrong target or payload hands the pasting file manager an empty or wrong
file, so these grades paste from a **second client process**, the way a file
manager does, and check what the app promises:

* the advertised targets (``TARGETS`` / ``--list-types``) are the three file
  targets, and listing them fetches nothing;
* ``text/uri-list`` is CRLF-terminated URIs and ``x-special/gnome-copied-files``
  / ``x-special/mate-copied-files`` a ``copy`` line plus LF-separated URIs; the
  URIs name staged files holding exactly the remote's bytes (a folder is not
  offered, a non-ASCII name is percent-encoded as UTF-8);
* every paste is a fresh fetch, and a target that was never advertised is
  refused without a fetch;
* another app copying takes the clipboard over (the app's promise is dropped,
  nothing is fetched meanwhile) and a new "Copy to clipboard" takes it back;
* quitting the app leaves no owner behind, and a relaunch does not re-own.

The remote is the ``mock-remote-desktop`` backend (built into the test app):
its ``remoteCopyFiles`` setting makes the "server" copy files, and each fetch
stages into its own ``fetch-<n>`` directory, so the returned paths show how many
fetches ran.

Both suites start their own servers, so a local run never touches the
developer's clipboard: a private Xvfb for the app's window and X11 owner, and
for the Wayland twin also a headless sway (wlroots implements
``wlr-data-control``; weston does not). The app runs on the Xvfb with
``GDK_BACKEND=x11`` and ``WAYLAND_DISPLAY`` naming the sway socket, so it binds
the native Wayland source *and* the X11 owner, as under XWayland. Linux-only;
the macOS/Windows lanes skip it (allowlisted in
``skip-allowlist.d/5170-linux-clipboard-owner.json``).
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Callable, ClassVar, Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)
from termihub_harness import linux_clipboard_clients as clients
from termihub_harness.linux_clipboard_clients import (
    FILE_TARGETS,
    WAYLAND_TOOLS,
    X11_TOOLS,
    ClipboardRead,
)

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not sys.platform.startswith("linux"),
        reason="the Linux clipboard owners are Linux-only",
    ),
]

CONNECTIONS = "connections.json"

#: What the mock "server" copies: two files and a folder (never offered).
REMOTE_FILES = (
    {"name": "alpha.txt", "content": "alpha bytes\n"},
    {"name": "folder", "isDir": True},
    {"name": "café ü.txt", "content": "unicode: grüße ✓\n"},
)
#: The pasteable files, in paste order: (staged basename, bytes).
PASTEABLE = [(f["name"], f["content"]) for f in REMOTE_FILES if not f.get("isDir")]
#: The non-ASCII name as the URI must carry it (percent-encoded UTF-8).
ENCODED_NAME = "caf%C3%A9%20%C3%BC.txt"

#: Budget for the bind to reach the clipboard after the click.
BIND_TIMEOUT = 30.0
#: Budget for the remote-desktop session to go live.
SESSION_TIMEOUT = 60.0

COPY_FILES = "remote-desktop-clipboard-copy-files"
FILES_LIST = "remote-desktop-clipboard-files"


def _connections_doc(name: str) -> str:
    """A v2 nested connections store with one mock remote desktop that copies files."""
    node = {
        "type": "connection",
        "name": name,
        "config": {
            "type": "mock-remote-desktop",
            "config": {"host": "mock", "remoteCopyFiles": list(REMOTE_FILES)},
        },
    }
    return json.dumps({"version": "2", "children": [node], "agents": []})


class _ClipboardOwnerSuite(RemoteDesktopUi, SettingsUi, SidebarUi, TabsUi, ConnectionsUi, SystemTest):
    """Seed the mock connection, open its tab, and copy its files to the host."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    #: The suite's private Xvfb display (set by ``extra_app_env``).
    display: ClassVar[str]
    connection: ClassVar[str]
    #: The staging roots the mock reported, removed after the suite.
    staging_roots: ClassVar[set[Path]]

    @classmethod
    def _start_xvfb(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        xvfb = clients.PrivateXvfb()
        request.addfinalizer(xvfb.close)
        cls.display = xvfb.display
        cls.staging_roots = set()

        def remove_staging() -> None:
            # A killed app leaves the mock's staging dirs behind.
            for root in cls.staging_roots:
                shutil.rmtree(root, ignore_errors=True)

        request.addfinalizer(remove_staging)
        return {"DISPLAY": xvfb.display, "GDK_BACKEND": "x11"}

    @pytest.fixture(autouse=True)
    def _seeded_connection(self):
        if not getattr(type(self), "connection", None):
            name = unique_name("clipboard-owner")
            type(self).connection = name
            self.restart_app(
                between=lambda: (self.config_dir / CONNECTIONS).write_text(
                    _connections_doc(name), encoding="utf-8"
                )
            )
            self.enable_experimental_features()
        yield

    # ── driving the app ─────────────────────────────────────────────────────
    def open_session(self) -> None:
        """Open a fresh mock session (its fetch counter starts at 1)."""
        self.close_all_tabs()
        self.switch_to_connections_sidebar()
        self.connect_connection(self.connection)
        self.wait(
            lambda: self.remote_desktop_phase() == "active",
            timeout=SESSION_TIMEOUT,
            what="the mock remote desktop to become active",
        )

    def copy_files_to_host(self, owned: Callable[[], bool]) -> None:
        """Open the clipboard panel and click "Copy to clipboard" until ``owned``."""
        if not self.driver.exists(self.CLIPBOARD_TEXT):
            self.driver.click(self.CLIPBOARD_BUTTON)
        self.wait(
            lambda: self.driver.exists(FILES_LIST),
            what="the remote's copied files in the clipboard panel",
        )
        self.driver.click(COPY_FILES)
        self.wait(owned, timeout=BIND_TIMEOUT, what="the app to own the clipboard")

    # ── grading payloads ────────────────────────────────────────────────────
    def staged(self, uris: list[str]) -> list[tuple[str, str, Optional[int]]]:
        """(basename, bytes, fetch number) of each staged file a payload names."""
        out = []
        for uri in uris:
            path = clients.file_uri_path(uri)
            assert path.is_file(), f"{uri} names no staged file"
            if path.parent.parent.name.startswith("termihub-mock-clipboard-"):
                type(self).staging_roots.add(path.parent.parent)
            out.append((path.name, path.read_text(encoding="utf-8"), clients.fetch_number(path)))
        return out

    def assert_fresh_fetch(self, uris: list[str], first_fetch: int) -> None:
        """The URIs name the pasteable files, fetched now as ``first_fetch``, ``+1``…"""
        assert any(u.endswith("/" + ENCODED_NAME) for u in uris), uris
        expected = [
            (name, content, first_fetch + i) for i, (name, content) in enumerate(PASTEABLE)
        ]
        assert self.staged(uris) == expected

    def grade_payloads(self, paste: Callable[[str], ClipboardRead], first_fetch: int) -> int:
        """Paste every file target once; returns the next fetch number."""
        read = paste("text/uri-list")
        assert read.ok, f"text/uri-list paste failed: {read.stderr}"
        self.assert_fresh_fetch(clients.parse_uri_list(read.data), first_fetch)
        first_fetch += len(PASTEABLE)
        for target in FILE_TARGETS[1:]:
            read = paste(target)
            assert read.ok, f"{target} paste failed: {read.stderr}"
            operation, uris = clients.parse_copied_files(read.data)
            assert operation == "copy"
            self.assert_fresh_fetch(uris, first_fetch)
            first_fetch += len(PASTEABLE)
        return first_fetch


@pytest.mark.requires_tools(*X11_TOOLS, platforms=("linux",))
class TestX11ClipboardOwner(_ClipboardOwnerSuite):
    """The X11 ``CLIPBOARD`` owner, read with ``xclip`` on the app's Xvfb."""

    unset_app_env = ("WAYLAND_DISPLAY",)

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        reason = clients.skip_reason(X11_TOOLS)
        if reason:
            pytest.skip(reason)
        return cls._start_xvfb(request)

    def targets(self) -> Optional[list[str]]:
        return clients.xclip_targets(self.display)

    def owns_files(self) -> bool:
        return all(t in (self.targets() or []) for t in FILE_TARGETS)

    def paste(self, target: str) -> ClipboardRead:
        return clients.xclip_read(self.display, target)

    def test_paste_serves_each_target_on_demand(self):
        self.open_session()
        self.copy_files_to_host(self.owns_files)
        assert self.targets() == ["TARGETS", *FILE_TARGETS]
        # Neither the copy nor the TARGETS probes fetched: the first paste is fetch 1.
        next_fetch = self.grade_payloads(self.paste, first_fetch=1)
        refused = self.paste("text/plain")
        assert not refused.ok, f"text/plain must be refused, got {refused.data!r}"
        # The refusal fetched nothing: the next paste continues the sequence.
        read = self.paste("text/uri-list")
        assert read.ok, read.stderr
        self.assert_fresh_fetch(clients.parse_uri_list(read.data), next_fetch)

    def test_another_owner_takes_over_and_copy_takes_it_back(self):
        self.open_session()
        self.copy_files_to_host(self.owns_files)
        other = clients.xclip_take(self.display, "another app's text")
        try:
            self.wait(
                lambda: self.paste("UTF8_STRING").data == b"another app's text",
                what="the other app to own CLIPBOARD",
            )
            assert not any(t in (self.targets() or []) for t in FILE_TARGETS)
            # Copying again re-owns; nothing was fetched while the other app owned it.
            self.copy_files_to_host(self.owns_files)
            self.grade_payloads(self.paste, first_fetch=1)
        finally:
            clients.stop(other)

    def test_quitting_the_app_releases_the_clipboard(self):
        self.open_session()
        self.copy_files_to_host(self.owns_files)

        def no_owner_while_down() -> None:
            self.wait(
                lambda: self.targets() is None,
                timeout=BIND_TIMEOUT,
                what="CLIPBOARD to have no owner once the app quit",
            )

        self.restart_app(between=no_owner_while_down)
        assert self.targets() is None, "a relaunched app must not re-own CLIPBOARD"


@pytest.mark.requires_tools(*X11_TOOLS, *WAYLAND_TOOLS, platforms=("linux",))
class TestWaylandClipboardSource(_ClipboardOwnerSuite):
    """The native ``wlr-data-control`` source, read with ``wl-paste`` on a headless sway."""

    socket: ClassVar[Path]

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        reason = clients.skip_reason((*X11_TOOLS, *WAYLAND_TOOLS))
        if reason:
            pytest.skip(reason)
        env = cls._start_xvfb(request)
        sway = clients.HeadlessSway()
        request.addfinalizer(sway.close)
        cls.socket = sway.socket
        return {**env, "WAYLAND_DISPLAY": str(sway.socket)}

    def types(self) -> Optional[list[str]]:
        return clients.wl_types(self.socket)

    def owns_files(self) -> bool:
        return all(t in (self.types() or []) for t in FILE_TARGETS)

    def offers_any_file_target(self) -> bool:
        return any(t in (self.types() or []) for t in FILE_TARGETS)

    def paste(self, target: str) -> ClipboardRead:
        return clients.wl_paste(self.socket, "--type", target)

    def test_paste_serves_each_type_on_demand(self):
        self.open_session()
        self.copy_files_to_host(self.owns_files)
        assert self.types() == list(FILE_TARGETS)
        next_fetch = self.grade_payloads(self.paste, first_fetch=1)
        refused = self.paste("text/plain")
        assert not refused.ok or not refused.data, f"text/plain must not be served: {refused}"
        read = self.paste("text/uri-list")
        assert read.ok, read.stderr
        self.assert_fresh_fetch(clients.parse_uri_list(read.data), next_fetch)

    def test_another_source_takes_over_and_copy_takes_it_back(self):
        self.open_session()
        self.copy_files_to_host(self.owns_files)
        other = clients.wl_take(self.socket, "another app's text")
        try:
            self.wait(
                lambda: self.paste("text/plain").data == b"another app's text",
                what="the other app's selection",
            )
            assert not self.offers_any_file_target()
            self.copy_files_to_host(self.owns_files)
            self.grade_payloads(self.paste, first_fetch=1)
        finally:
            clients.stop(other)

    def test_quitting_the_app_withdraws_the_selection(self):
        self.open_session()
        self.copy_files_to_host(self.owns_files)

        def no_offer_while_down() -> None:
            self.wait(
                lambda: not self.offers_any_file_target(),
                timeout=BIND_TIMEOUT,
                what="the selection to drop the file types once the app quit",
            )

        self.restart_app(between=no_offer_while_down)
        assert not self.offers_any_file_target(), "a relaunched app must not re-offer files"
