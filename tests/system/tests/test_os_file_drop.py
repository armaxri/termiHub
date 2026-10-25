"""Automated OS file drops: synthetic Tauri drag-drop events on every OS (#4936).

Tauri catches an OS file drag natively and hands the page four window events
(``tauri://drag-enter`` / ``-over`` / ``-drop`` / ``-leave``) with physical
webview coordinates. :class:`~termihub_harness.OsDropUi` emits exactly those
through the bridge, so the app half of a drop runs unchanged: the hover
highlight, hit-testing the pane under the cursor, quoting the paths for the
shell, copying into the file browser's folder. The native half — real X11 XDND
between windows, including dragging rows *out* — is graded in
``test_os_file_drop_xdnd.py``.

Retires MT-NIN-01 (multi-file drop quoting, together with the XDND grade),
MT-NIN-05 (drop onto the file browser copies), MT-UI-34 (the drop lands in the
pane under the cursor) and MT-FB-30 (a 5000-entry folder stays virtualised and
accepts a drop). The hit-testing grade also covers the 1x half of MT-NIN-02;
a real scaled display stays guided.

Integration lane (nightly).
"""

from __future__ import annotations

import re
import shutil
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional
import pytest

from termihub_harness import (
    FilesUi,
    LayoutUi,
    OsDropUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
)
from termihub_harness.ui.terminal import NEW_TERMINAL
from termihub_harness.ui.windows import window_tabs

pytestmark = pytest.mark.integration

SPLIT_H = "terminal-view-split-horizontal"
FB_LIST = "file-browser-list"
FB_OVERLAY = "file-browser-drag-overlay"
#: How long a drop that must change nothing is watched before it counts as ignored.
QUIET_WINDOW = 1.5


def quote_path(path: str) -> str:
    """Mirror of ``src/utils/quotePath.ts``: how a dropped path reaches the shell."""
    if re.match(r"^[A-Za-z]:", path) or "\\" in path:
        return '"' + path.replace('"', '\\"') + '"'
    return "'" + path.replace("'", "'\\''") + "'"


def squash(text: str) -> str:
    """``text`` without whitespace, so a soft-wrapped prompt line still matches."""
    return "".join(text.split())


def pane_overlay(panel_id: str) -> str:
    return f"panel-file-drag-overlay-{panel_id}"


class TestSyntheticOsFileDrop(
    OsDropUi, TerminalUi, TabsUi, LayoutUi, SidebarUi, FilesUi, SystemTest
):
    """The app half of an OS file drop, graded from the terminal, the disk and the DOM."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _scratch(self, prefix: str) -> Path:
        return Path(tempfile.mkdtemp(prefix=f"thub-{prefix}-")).resolve()

    def _wait_prompt(self, tab_id: str) -> None:
        self.wait(lambda: self.driver.read_terminal(tab_id).strip(), what="the shell prompt")

    def _wait_inserted(self, tab_id: str, paths: list[Path]) -> str:
        expected = squash(" ".join(quote_path(str(p)) for p in paths))

        def inserted() -> Optional[str]:
            text = self.driver.read_terminal(tab_id)
            return text if expected in squash(text) else None

        return self.wait(inserted, what=f"the dropped paths {expected!r} on the prompt line")

    def _assert_unchanged(self, tab_id: str, before: str, what: str) -> None:
        time.sleep(QUIET_WINDOW)
        assert self.driver.read_terminal(tab_id) == before, what

    # ── MT-NIN-01: a multi-file drop is quoted for the platform's shell ──────
    def test_multi_file_drop_is_quoted_per_platform(self):
        """MT-NIN-01: three files (a space and an apostrophe among them) dropped
        together are inserted quoted — POSIX single quotes with ' as '\\'' ,
        Windows double quotes — highlight while hovering, run nothing until
        Enter, and the shell then sees exactly those three paths."""
        folder = self._scratch("nin01")
        names = ("plain.txt", "two words.txt", "it's.txt")
        paths = [folder / name for name in names]
        for path in paths:
            path.write_text("x\n", encoding="utf-8")
        self.close_all_tabs()
        self.ensure_terminal()
        tab_id = self.active_tab()["id"]  # type: ignore[index]
        self._wait_prompt(tab_id)
        panel = self.panel_of_tab(tab_id)
        assert panel is not None
        renderer = f"terminal-renderer-{tab_id}"
        posix = sys.platform != "win32"
        if posix:
            # A line continuation, so the dropped paths become printf's arguments
            # (printf, not ls: GNU ls re-quotes names with spaces on a TTY).
            self.run_command("printf 'ARG<%s>\\n' \\")

        self.os_drag_enter(renderer, paths)
        self.wait(lambda: self.driver.exists(pane_overlay(panel)), what="the drop highlight")
        self.os_drop(renderer, paths)
        self.wait(lambda: not self.driver.exists(pane_overlay(panel)), what="the highlight to go")
        inserted = self._wait_inserted(tab_id, paths)
        assert "No such file" not in inserted and "not found" not in inserted.lower()

        if not posix:
            # The Windows grade is the inserted text; discard the line.
            self.driver.press_key("c", f"terminal-input-{tab_id}", ctrl=True)
            return
        self.driver.press_key("Enter", f"terminal-input-{tab_id}")
        expected = [f"ARG<{p}>" for p in paths]

        def printed() -> Optional[list[str]]:
            rows = [r.strip() for r in self.driver.read_terminal(tab_id).splitlines()]
            args = [r for r in rows if r.startswith("ARG<")]
            return args if all(line in args for line in expected) else None

        args = self.wait(printed, what="the shell to receive exactly the three dropped paths")
        assert args[-3:] == expected, args

    # ── MT-UI-34: the drop lands in the pane under the cursor ────────────────
    def test_drop_targets_only_the_pane_under_the_cursor(self):
        """MT-UI-34: with two shell panes the highlight follows the cursor from
        one pane to the other and is gone over the tab bar; a drop inserts the
        path only into the pane it was released over, and a drop on the tab bar
        inserts nothing. (MT-NIN-02's hit-testing at the runner's scale.)"""
        self.close_all_tabs()
        self.ensure_terminal()
        self.driver.click(SPLIT_H)
        self.wait(lambda: self.leaf_count() == 2, what="two panes")
        self.driver.click(NEW_TERMINAL)
        first = self.wait(lambda: (window_tabs(self.driver) or [None])[0], what="the first tab")
        first_panel = self.panel_of_tab(first["id"])
        second = self.wait(
            lambda: next(
                (t for t in window_tabs(self.driver) if self.panel_of_tab(t["id"]) != first_panel),
                None,
            ),
            what="a shell in the second pane",
        )
        second_panel = self.panel_of_tab(second["id"])
        assert first_panel and second_panel and first_panel != second_panel
        for tab in (first, second):
            self._wait_prompt(tab["id"])
        folder = self._scratch("ui34")
        dropped = folder / "drop-me.txt"
        dropped.write_text("file-drop payload\n", encoding="utf-8")
        first_r, second_r = (f"terminal-renderer-{t['id']}" for t in (first, second))

        def overlays() -> tuple[bool, bool]:
            return (
                self.driver.exists(pane_overlay(first_panel)),
                self.driver.exists(pane_overlay(second_panel)),
            )

        self.os_drag_enter(first_r, [dropped])
        self.wait(lambda: overlays() == (True, False), what="only the first pane highlighted")
        self.os_drag_over(second_r)
        self.wait(lambda: overlays() == (False, True), what="only the second pane highlighted")
        self.os_drag_over(f"tab-{second['id']}")
        self.wait(lambda: overlays() == (False, False), what="no highlight over the tab bar")
        self.os_drag_leave()

        before_first = self.driver.read_terminal(first["id"])
        self.os_drop(second_r, [dropped])
        self._wait_inserted(second["id"], [dropped])
        self._assert_unchanged(first["id"], before_first, "the other pane received the drop")
        assert overlays() == (False, False)

        other = folder / "tab-bar.txt"
        other.write_text("x\n", encoding="utf-8")
        before = [self.driver.read_terminal(t["id"]) for t in (first, second)]
        self.os_drop(f"tab-{first['id']}", [other])
        time.sleep(QUIET_WINDOW)
        after = [self.driver.read_terminal(t["id"]) for t in (first, second)]
        assert after == before, "a drop on the tab bar inserted a path"

    # ── MT-NIN-05: a drop onto the file browser copies into its folder ───────
    def _browse(self, folder: Path, timeout: float = 30.0) -> None:
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(f'cd "{folder}"')
        self.open_file_browser()
        self.wait_for_path_contains(folder.name, timeout=timeout)
        self.wait(lambda: self.driver.exists(FB_LIST), timeout=timeout, what="the listing")

    def test_os_drop_onto_file_browser_copies_into_folder(self):
        """MT-NIN-05: dragging a file over the file-browser listing highlights it;
        dropping copies the file into the shown folder and leaves the source."""
        target = self._scratch("nin05-target")
        source = self._scratch("nin05-source") / "copy-me.txt"
        source.write_text("payload\n", encoding="utf-8")
        self._browse(target)
        self.os_drag_enter(FB_LIST, [source])
        self.wait(lambda: self.driver.exists(FB_OVERLAY), what="the file-browser highlight")
        self.os_drop(FB_LIST, [source])
        self.wait(lambda: not self.driver.exists(FB_OVERLAY), what="the highlight to go")
        copied = target / "copy-me.txt"
        self.wait(lambda: copied.exists(), what=f"{copied} to be copied")
        self.wait(lambda: copied.read_text(encoding="utf-8") == "payload\n", what="its contents")
        assert source.read_text(encoding="utf-8") == "payload\n", "the drop moved the source"
        self.wait_for_file_row("copy-me.txt")

    # ── MT-FB-30: a 5000-entry folder stays virtualised and accepts a drop ───
    def test_large_directory_stays_virtualised_and_accepts_os_drop(self):
        """MT-FB-30: a folder of 5000 files lists without freezing the UI: only a
        window of rows is mounted, the last entry is reachable, the bridge stays
        responsive, and a dropped file is copied into the folder."""
        folder = self._scratch("fb30")
        try:
            for i in range(5000):
                (folder / f"file-{i:05d}.txt").write_text("x", encoding="utf-8")
            self._browse(folder, timeout=60.0)
            self.wait(
                lambda: self.file_row_exists("file-00000.txt"), timeout=60.0, what="the first row"
            )
            assert not self.file_row_exists("file-02500.txt"), "rows are not virtualised"
            assert not self.file_row_exists("file-04999.txt"), "rows are not virtualised"
            started = time.monotonic()
            for _ in range(10):
                self.driver.exists(FB_LIST)
            per_call = (time.monotonic() - started) / 10
            assert per_call < 1.0, f"the UI is sluggish with 5000 rows ({per_call:.2f}s/call)"

            dropped = self._scratch("fb30-src") / "zz-dropped.txt"
            dropped.write_text("dropped\n", encoding="utf-8")
            self.os_drop(FB_LIST, [dropped])
            copied = folder / dropped.name
            self.wait(lambda: copied.exists(), timeout=30.0, what="the dropped file to be copied")
            self.wait_for_file_row("file-04999.txt", timeout=60.0)
            self.wait_for_file_row(dropped.name, timeout=60.0)
            self.clear_entry_filter()
        finally:
            shutil.rmtree(folder, ignore_errors=True)

