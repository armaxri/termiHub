"""Real native file drag-and-drop on macOS and Windows (#4998).

The macOS/Windows counterpart of ``test_os_file_drop_xdnd.py``. Harness-owned
partner windows (:mod:`termihub_harness.os_input.native_dnd` — AppKit through
pyobjc on macOS, Win32/OLE through ctypes on Windows) act as the file manager,
and the real pointer (HID-tap events on macOS, ``SendInput`` on Windows, both
refused unless the frontmost window is the test instance or a partner) drags:

- files from a :class:`NativeSource` onto the terminal and onto the file browser
  (WKWebView / WebView2 drop target → Tauri → ``useOsFileDrop``);
- file-browser rows out to a :class:`NativeTarget` (the app's drag source: the
  ``drag`` crate's ``NSDraggingSession`` / ``DoDragDrop`` backend,
  ``drag_out_start``), and back over termiHub, where they must be ignored.

Grades MT-NIN-06 (a row dragged out lands in the OS folder; dragged back it is
not re-imported) and MT-FB-31 for local rows (a file and a file+folder
selection drag out as copies) on macOS and Windows, plus a real drop onto the
terminal and the file browser (MT-NIN-01 / MT-NIN-05 natively). The SFTP half
of MT-FB-31 needs the Docker fixtures, which the hosted macOS/Windows runners do
not have; it stays graded on Linux by the XDND suite.

macOS/Windows integration lane only, in the OS-input step (``-n 1``: the desktop
to itself). On a developer machine it skips unless ``TERMIHUB_OS_INPUT_GLOBAL=1``
says nothing else is on the display.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import time
from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    LayoutUi,
    OsInputUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
)
from termihub_harness.os_input import ScreenMapper, native_dnd, primary_modifier
from termihub_harness.os_input.native_dnd import NativeSource, NativeTarget
from termihub_harness.os_input.xdnd import free_region, native_drag
from termihub_harness.ui.files import file_row_testid

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        sys.platform not in ("darwin", "win32"),
        reason="native macOS/Windows drags; X11 runs the XDND suite",
    ),
]

FB_LIST = "file-browser-list"
FB_OVERLAY = "file-browser-drag-overlay"
FB_FILTER = "file-browser-filter"
PARTNER_SIZE = (240, 200)
#: The largest app window the suite uses; on a small screen (the hosted macOS
#: runner's is 1024x768) it shrinks so a partner window still fits beside it.
APP_SIZE = (900, 620)
#: Gap kept between the app window, a partner window and the screen edges.
MARGIN = 20
PAYLOAD = "native payload\n"


def quote_path(path: str) -> str:
    """Mirror of ``src/utils/quotePath.ts``: how a dropped path reaches the shell."""
    if re.match(r"^[A-Za-z]:", path) or "\\" in path:
        return '"' + path.replace('"', '\\"') + '"'
    return "'" + path.replace("'", "'\\''") + "'"


def squash(text: str) -> str:
    """``text`` without whitespace, so a soft-wrapped prompt line still matches."""
    return "".join(text.split())


class TestNativeFileDrag(
    OsInputUi, TerminalUi, TabsUi, LayoutUi, SidebarUi, FilesUi, ConnectionsUi, SystemTest
):
    """Real native drags between harness-owned windows and the test instance."""

    # ── Plumbing ─────────────────────────────────────────────────────────────
    def _require_partners(self) -> None:
        self.os_input()  # skips / fails with the OS-input reason first
        reason = native_dnd.unavailable_reason()
        if reason is not None:
            if os.environ.get("GITHUB_ACTIONS") == "true":
                pytest.fail(f"native drag partners unavailable on the CI runner: {reason}")
            pytest.skip(reason)

    def _scratch(self, prefix: str) -> Path:
        return Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-")).resolve()

    def _stage(self) -> ScreenMapper:
        """Size the window so a partner fits beside it; return its mapper."""
        width, height = self.os_input().screen_size()
        self.driver.resize_window(
            min(APP_SIZE[0], width - PARTNER_SIZE[0] - 3 * MARGIN),
            min(APP_SIZE[1], height - 4 * MARGIN),
        )
        time.sleep(0.5)
        return self.os_activate()

    def _partner_geometry(self, screen: ScreenMapper) -> tuple[int, int, int, int]:
        x, y = free_region(
            self.os_input().screen_size(), screen.window, PARTNER_SIZE, margin=MARGIN
        )
        return (x, y, *PARTNER_SIZE)

    def _partner_center(self, pid: int) -> tuple[int, int]:
        osi = self.os_input()
        osi.allow_pid(pid)
        windows = osi._wait(lambda: osi.windows(pid), 15.0, f"partner {pid}'s window")  # noqa: SLF001
        return windows[0].center

    def _browse(self, folder: Path) -> None:
        self.close_all_tabs()
        # A terminal whose shell reports its cwd, so the file browser follows the cd.
        self.open_cwd_following_terminal()
        self.run_command(f'cd "{folder}"')
        self.open_file_browser()
        self.wait_for_path_contains(folder.name)
        self.wait(lambda: self.driver.exists(FB_LIST), what="the listing")
        self.clear_entry_filter()

    def _drag_rows_out(self, row: str, target: NativeTarget, *, hover: float = 2.0) -> None:
        screen = self.os_activate()
        drop_at = self._partner_center(target.pid)
        native_drag(self.os_input(), screen.point(file_row_testid(row)), [drop_at], hover=hover)

    def _wait_dropped(self, source: NativeSource, count: int) -> None:
        """The source reported its ``count``-th drag ended in a drop."""
        ends = self.wait(
            lambda: len(source.drag_ends()) >= count and source.drag_ends(),
            timeout=20.0,
            what=f"the source's drag #{count} to end",
        )
        assert ends[count - 1].get("dropped"), f"the native drag was not accepted: {ends}"

    # ── Drag in: native source → terminal / file browser ────────────────────
    def test_real_drop_onto_terminal_and_file_browser(self):
        """MT-NIN-01 / MT-NIN-05 natively on macOS and Windows: files dragged
        from another app onto the terminal are inserted quoted for the shell;
        dragged onto the file-browser listing they highlight it and are copied
        into its folder, the sources untouched."""
        self._require_partners()
        osi = self.os_input()
        folder = self._scratch("ndnd-in")
        paths = [folder / n for n in ("plain.txt", "two words.txt", "it's.txt")]
        for path in paths:
            path.write_text(PAYLOAD, encoding="utf-8")
        target = self._scratch("ndnd-in-target")
        self._browse(target)
        tab_id = self.active_tab()["id"]  # type: ignore[index]
        screen = self._stage()
        with NativeSource(paths, self._partner_geometry(screen)) as source:
            start = self._partner_center(source.pid)

            native_drag(osi, start, [screen.point(f"terminal-renderer-{tab_id}")])
            self._wait_dropped(source, 1)
            expected = squash(" ".join(quote_path(str(p)) for p in paths))
            self.wait(
                lambda: expected in squash(self.driver.read_terminal(tab_id)),
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
            self._wait_dropped(source, 2)
            assert any(seen), "the file browser never highlighted under the native drag"
            for path in paths:
                copied = target / path.name
                self.wait(lambda c=copied: c.exists(), what=f"{copied} to be copied")
                assert copied.read_text(encoding="utf-8") == PAYLOAD
                assert path.exists(), "the drop moved the source"
        self.os_activate()

    # ── Drag out: file-browser rows → native target, and back ───────────────
    def test_row_dragged_out_lands_in_the_os_folder_and_is_not_reimported(self):
        """MT-NIN-06 on macOS and Windows: a row dragged out of the file browser
        onto another app's folder lands there with the same contents. Dragged out
        again and brought back over termiHub — across the file browser, released
        on the terminal — it neither highlights nor inserts anything. MT-FB-31
        (local): a file and a file+folder selection drag out as copies; the
        originals stay."""
        self._require_partners()
        osi = self.os_input()
        folder = self._scratch("ndnd-out")
        (folder / "drag-out.txt").write_text("drag-out\n", encoding="utf-8")
        (folder / "zz-folder").mkdir()
        (folder / "zz-folder" / "inner.txt").write_text("inner\n", encoding="utf-8")
        dest = self._scratch("ndnd-out-dest")
        self._browse(folder)
        tab_id = self.active_tab()["id"]  # type: ignore[index]
        self.wait_for_file_row("drag-out.txt")
        screen = self._stage()
        with NativeTarget(dest, self._partner_geometry(screen)) as target:
            self._drag_rows_out("drag-out.txt", target)
            target.wait_event("drop", timeout=20.0)
            landed = dest / "drag-out.txt"
            self.wait(lambda: landed.exists(), what=f"{landed} in the OS folder")
            assert landed.read_text(encoding="utf-8") == "drag-out\n"
            assert (folder / "drag-out.txt").exists(), "the drag-out moved the original"

            # Out and back: the app's own drag must not be re-imported.
            before = self.driver.read_terminal(tab_id)
            screen = self.os_activate()
            panel = self.panel_of_tab(tab_id)
            seen: list[bool] = []

            def probe(index: int) -> None:
                if index >= 1:
                    seen.append(self.driver.exists(FB_OVERLAY))
                    seen.append(self.driver.exists(f"panel-file-drag-overlay-{panel}"))

            native_drag(
                osi,
                screen.point(file_row_testid("drag-out.txt")),
                [
                    screen.outside_point(),
                    screen.point(FB_LIST, fy=0.8),
                    screen.point(f"terminal-renderer-{tab_id}"),
                ],
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
            # The first click after a real drag can be swallowed (#4978): spend it.
            self.os_click(FB_FILTER, screen=screen)
            self.os_click(file_row_testid("drag-out.txt"), screen=screen)
            # Cmd-click on macOS (Ctrl-click is the context menu there).
            modifier = primary_modifier()
            osi.key_down(modifier)
            try:
                self.os_click(file_row_testid("zz-folder"), screen=screen)
            finally:
                osi.key_up(modifier)
            (dest / "drag-out.txt").unlink()
            drops = len(target.events("drop"))
            self._drag_rows_out("zz-folder", target)
            self.wait(lambda: len(target.events("drop")) > drops, timeout=20.0, what="a 2nd drop")
            self.wait(lambda: (dest / "zz-folder" / "inner.txt").exists(), what="the folder tree")
            self.wait(lambda: (dest / "drag-out.txt").exists(), what="the selected file")
            assert (folder / "zz-folder" / "inner.txt").read_text(encoding="utf-8") == "inner\n"
        self.os_activate()
