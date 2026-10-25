"""Real native file drag-and-drop on X11: XDND in and out of the test instance (#4936).

``test_os_file_drop.py`` grades the app half of a drop on every OS from
synthetic Tauri events. This suite drives the **native** half on the CI Xvfb
display: harness-owned GTK windows (:mod:`termihub_harness.os_input.xdnd`) act
as the file manager, and the real pointer — XTEST, aimed by PID, refused unless
the frontmost window is the test instance or one of those partners — drags:

- files from an :class:`XdndSource` onto the terminal and onto the file
  browser (WebKitGTK's XDND drop target → Tauri → ``useOsFileDrop``);
- file-browser rows out to an :class:`XdndTarget` (the app's GTK drag source,
  ``drag_out_start``), and back over termiHub, where they must be ignored.

Retires MT-NIN-06 (a row dragged out lands in the OS folder; dragged back it is
not re-imported) and MT-FB-31 (drag out a file, a file+folder selection, and a
remote SFTP folder), and with ``test_os_file_drop.py`` MT-NIN-01 and MT-NIN-05.
It is the X11 half of MT-NIN-04; the Wayland session stays guided.

Linux integration lane only (X11). On a developer machine it skips unless
``TERMIHUB_OS_INPUT_GLOBAL=1`` says nothing else is on the display.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

import pytest

from termihub_harness import (
    ComposeFixtureFailed,
    ConnectionsUi,
    ContainerRuntimeUnavailable,
    FilesUi,
    LayoutUi,
    OsInputUi,
    PasswordPromptUi,
    SftpUi,
    SidebarUi,
    SshServerControl,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.os_input import ScreenMapper, xdnd
from termihub_harness.os_input.xdnd import XdndSource, XdndTarget, free_region, native_drag
from termihub_harness.ui.files import file_row_testid
from termihub_harness.ui.os_input_ui import linux_window_manager

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not sys.platform.startswith("linux"), reason="X11 XDND is Linux-only"),
]

FB_LIST = "file-browser-list"
FB_OVERLAY = "file-browser-drag-overlay"
PARTNER_SIZE = (260, 200)
#: Window size that leaves screen room for a partner window beside it.
APP_SIZE = (900, 620)
#: The ``ssh-password`` fixture user's home.
REMOTE_HOME = "/home/testuser"


@pytest.fixture(scope="class", autouse=True)
def _window_manager() -> Iterator[None]:
    with linux_window_manager():
        yield


def quote_path(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


class _XdndSuite(OsInputUi):
    """Shared plumbing: partner windows beside the app, real drags between them."""

    def _require_xdnd(self) -> None:
        self.os_input()  # skips / fails with the OS-input reason first
        reason = xdnd.unavailable_reason()
        if reason is not None:
            if os.environ.get("GITHUB_ACTIONS") == "true":
                pytest.fail(f"XDND partners unavailable on the CI runner: {reason}")
            pytest.skip(reason)

    def _scratch(self, prefix: str) -> Path:
        return Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-")).resolve()

    def _stage(self) -> ScreenMapper:
        """Size the window so a partner fits beside it; return its mapper."""
        self.driver.resize_window(*APP_SIZE)
        time.sleep(0.5)
        return self.os_activate()

    def _partner_geometry(self, screen: ScreenMapper) -> tuple[int, int, int, int]:
        x, y = free_region(self.os_input().screen_size(), screen.window, PARTNER_SIZE)
        return (x, y, *PARTNER_SIZE)

    def _partner_center(self, pid: int) -> tuple[int, int]:
        osi = self.os_input()
        osi.allow_pid(pid)
        windows = osi._wait(lambda: osi.windows(pid), 15.0, f"partner {pid}'s window")  # noqa: SLF001
        return windows[0].center

    def _drag_rows_out(self, row: str, target: XdndTarget, *, hover: float = 2.0) -> None:
        screen = self.os_activate()
        drop_at = self._partner_center(target.pid)
        native_drag(self.os_input(), screen.point(file_row_testid(row)), [drop_at], hover=hover)


class TestXdndFileDrop(_XdndSuite, TerminalUi, TabsUi, LayoutUi, SidebarUi, FilesUi, SystemTest):
    """Real XDND drags between harness-owned GTK windows and the test instance."""

    def _browse(self, folder: Path) -> None:
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(f'cd "{folder}"')
        self.open_file_browser()
        self.wait_for_path_contains(folder.name)
        self.wait(lambda: self.driver.exists(FB_LIST), what="the listing")

    # ── Drag in: XDND source → terminal / file browser ───────────────────────
    def test_real_drop_onto_terminal_and_file_browser(self):
        """MT-NIN-01 / MT-NIN-04 (X11) / MT-NIN-05 natively: files dragged from
        another X11 app onto the terminal are inserted quoted; dragged onto the
        file-browser listing they highlight it and are copied into its folder."""
        self._require_xdnd()
        osi = self.os_input()
        folder = self._scratch("xdnd-in")
        paths = [folder / n for n in ("plain.txt", "two words.txt", "it's.txt")]
        for path in paths:
            path.write_text("xdnd payload\n", encoding="utf-8")
        target = self._scratch("xdnd-in-target")
        self._browse(target)
        tab_id = self.active_tab()["id"]  # type: ignore[index]
        screen = self._stage()
        with XdndSource(paths, self._partner_geometry(screen)) as source:
            start = self._partner_center(source.pid)

            native_drag(osi, start, [screen.point(f"terminal-renderer-{tab_id}")])
            source.wait_event("data-get")
            expected = "".join(" ".join(quote_path(str(p)) for p in paths).split())
            self.wait(
                lambda: expected in "".join(self.driver.read_terminal(tab_id).split()),
                what="the natively dropped paths on the prompt line",
            )
            self.driver.press_key("c", f"terminal-input-{tab_id}", ctrl=True)

            seen: list[bool] = []
            screen = self.os_activate()
            native_drag(
                osi,
                start,
                [screen.point(FB_LIST)],
                on_hover=lambda _i: seen.append(self.driver.exists(FB_OVERLAY)),
            )
            assert any(seen), "the file browser never highlighted under the native drag"
            for path in paths:
                copied = target / path.name
                self.wait(lambda c=copied: c.exists(), what=f"{copied} to be copied")
                assert copied.read_text(encoding="utf-8") == "xdnd payload\n"
                assert path.exists(), "the drop moved the source"
        self.os_activate()

    # ── Drag out: file-browser rows → XDND target, and back ──────────────────
    def test_row_dragged_out_lands_in_the_os_folder_and_is_not_reimported(self):
        """MT-NIN-06: a row dragged out of the file browser onto another app's
        folder lands there with the same contents. Dragged out again and brought
        back over termiHub — across the file browser, released on the terminal —
        it neither highlights nor inserts anything. MT-FB-31 (local): a file and
        a file+folder selection drag out as copies; the originals stay."""
        self._require_xdnd()
        osi = self.os_input()
        folder = self._scratch("xdnd-out")
        (folder / "drag-out.txt").write_text("drag-out\n", encoding="utf-8")
        (folder / "zz-folder").mkdir()
        (folder / "zz-folder" / "inner.txt").write_text("inner\n", encoding="utf-8")
        dest = self._scratch("xdnd-out-dest")
        self._browse(folder)
        tab_id = self.active_tab()["id"]  # type: ignore[index]
        self.wait_for_file_row("drag-out.txt")
        screen = self._stage()
        with XdndTarget(dest, self._partner_geometry(screen)) as target:
            self._drag_rows_out("drag-out.txt", target)
            target.wait_event("drop", timeout=20.0)
            landed = dest / "drag-out.txt"
            self.wait(lambda: landed.exists(), what=f"{landed} in the OS folder")
            assert landed.read_text(encoding="utf-8") == "drag-out\n"
            assert (folder / "drag-out.txt").exists(), "the drag-out moved the original"

            # Out and back: the app's own drag must not be re-imported.
            before = self.driver.read_terminal(tab_id)
            screen = self.os_activate()
            outside = screen.outside_point()
            seen: list[bool] = []

            panel = self.panel_of_tab(tab_id)

            def probe(index: int) -> None:
                if index >= 1:
                    seen.append(self.driver.exists(FB_OVERLAY))
                    seen.append(self.driver.exists(f"panel-file-drag-overlay-{panel}"))

            native_drag(
                osi,
                screen.point(file_row_testid("drag-out.txt")),
                [outside, screen.point(FB_LIST, fy=0.8), screen.point(f"terminal-renderer-{tab_id}")],
                hover=1.5,
                on_hover=probe,
            )
            time.sleep(1.5)
            assert not any(seen), "the app highlighted its own drag-out as an incoming drop"
            assert self.driver.read_terminal(tab_id) == before, "its own drag was re-imported"
            assert sorted(p.name for p in folder.iterdir()) == ["drag-out.txt", "zz-folder"]

            # A file + folder selection drags out together.
            self.clear_entry_filter()
            self.wait(lambda: self.file_row_exists("zz-folder"), what="the folder row")
            screen = self.os_activate()
            self.os_click(file_row_testid("drag-out.txt"), screen=screen)
            osi.key_down("ctrl")
            try:
                self.os_click(file_row_testid("zz-folder"), screen=screen)
            finally:
                osi.key_up("ctrl")
            (dest / "drag-out.txt").unlink()
            drops = len(target.events("drop"))
            self._drag_rows_out("zz-folder", target)
            self.wait(lambda: len(target.events("drop")) > drops, timeout=20.0, what="a 2nd drop")
            self.wait(lambda: (dest / "zz-folder" / "inner.txt").exists(), what="the folder tree")
            self.wait(lambda: (dest / "drag-out.txt").exists(), what="the selected file")
            assert (folder / "zz-folder" / "inner.txt").read_text(encoding="utf-8") == "inner\n"
        self.os_activate()


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestXdndSftpDragOut(
    _XdndSuite,
    TerminalUi,
    TabsUi,
    LayoutUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    FilesUi,
    SystemTest,
):
    """A remote folder dragged out of the SFTP browser is staged, then dropped natively."""

    def test_remote_folder_drags_out_with_its_tree(self):
        """MT-FB-31 (SFTP): a remote folder dragged out and held outside the
        window is staged through the transfer queue, then lands in the other
        app's folder with its full tree; the remote original stays."""
        self._require_xdnd()
        server = SshServerControl()
        if not server.available:
            pytest.skip("no container runtime to seed the remote folder")
        name = unique_name("sftp-out")
        remote = f"{REMOTE_HOME}/{name}"
        dest = self._scratch("xdnd-sftp-dest")
        try:
            self.connect_ssh_password(unique_name("sftp-out-conn"))
            self.run_command(
                f"mkdir -p {name}/sub && printf 'top\\n' > {name}/a.txt"
                f" && printf 'deep\\n' > {name}/sub/b.txt"
            )
            self.wait(lambda: server.path_exists(f"{remote}/sub/b.txt"), what="the remote tree")
            self.connect_sftp_browser()
            self.wait_for_path_contains(REMOTE_HOME)
            self.wait_for_file_row(name)
            screen = self._stage()
            with XdndTarget(dest, self._partner_geometry(screen)) as target:
                # Held outside the window until staging finishes and the native drag starts.
                self._drag_rows_out(name, target, hover=12.0)
                target.wait_event("drop", timeout=30.0)
                top, deep = dest / name / "a.txt", dest / name / "sub" / "b.txt"
                self.wait(lambda: deep.exists() and top.exists(), what="the staged tree")
                assert top.read_text(encoding="utf-8") == "top\n"
                assert deep.read_text(encoding="utf-8") == "deep\n"
            assert server.path_exists(f"{remote}/sub/b.txt"), "the drag-out moved the original"
        finally:
            self.close_all_tabs()
            try:
                server.remove_path(remote)
            except (ContainerRuntimeUnavailable, ComposeFixtureFailed):
                pass
            self.os_activate()
