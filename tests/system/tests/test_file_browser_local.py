"""Local file browser: browse, navigate, create, context menu, CWD-awareness.

Ported from ``tests/e2e/file-browser-local.test.js`` and
``file-browser-extended.test.js`` onto the Python bridge harness (#809).

The browser is driven through its real toolbar/row testids and asserted against
what the user sees — ``file-browser-current-path`` (the breadcrumb path bar,
read via its ``title``) for the path and ``file-row-<name>`` for entries.

**Where the browser points (#1651).** The suite does not browse the real
``$HOME``: that made results depend on whatever the runner happens to have in its
home dir, and a failed/interrupted run could leave ``e2e_fb_*`` litter behind in
it. Instead each test browses a **purpose-made temporary directory** created and
seeded by the ``scratch_workspace`` fixture, ``cd``'d into via the local terminal
so the browser follows the CWD there (the browser follows the active terminal's
directory — PR #39). The fixture tears the temp dir down on the host filesystem
in a ``finally``, so it is removed even when a test fails, and nothing lands in
``$HOME``. The temp dir is seeded with **more entries than the virtualizer mounts
at once** (see ``SEED_DIR_COUNT`` / ``SEED_FILE_COUNT``), so every created/asserted
``e2e_fb_*`` entry sorts *below the fold* and the virtualization-aware
``wait_for_file_row`` filter path stays covered — the regression #1582 fixed.

Known entries are created directly on the temp dir's filesystem (the app runs on
the same host as the test runner) or via the browser's own New File/Folder inputs,
so a test never depends on OSC 7 cwd-following timing for its fixtures. The
dedicated CWD-aware tests below *do* exercise cwd-following (against ``/tmp`` /
``/etc``) and wait for the displayed path to settle.

**Journeys (#4007).** A multi-selection delete that hits an undeletable folder
keeps going and removes the rest (#1348 / #1394), and drag-to-move (PROD-006,
#3454): a pointer drag of a file onto a folder row highlights the row and shows
the "Move" chip mid-drag, then moves the file; a drop on a breadcrumb segment
moves it up; a folder dropped on its own row is marked refused and stays put;
and an Alt-held drag copies instead. All asserted on the real filesystem, not
just the listing (the SFTP twin is ``test_file_browser_drag_sftp_live.py``).

Not ported (kept as manual tests in docs/testing.md): three-dots row-menu vs
context-menu styling parity and other pure-visual checks; the rename inline-input
flow (covered indirectly — delete exercises the same context-menu refresh path).
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    file_row_testid,
    unique_name,
)
from termihub_harness.shell import is_absolute_path

pytestmark = pytest.mark.integration

#: The floating chip that follows a file-browser drag ("Move …" / "Copy …").
DRAG_CHIP = "file-browser-drag-chip"

# The temp dir is seeded with enough entries that the file browser's virtualizer
# (``@tanstack/react-virtual``, ~33 rows mounted at the default sidebar height)
# cannot mount them all — so any created/asserted ``e2e_fb_*`` entry sorts below
# the mounted window and only ``wait_for_file_row``'s filter path can reveal it.
# Directories sort before files (``sortEntries``), so both groups are seeded past
# the window: the seed dirs push a created ``e2e_fb_*`` *directory* offscreen, and
# the full dir group alone already pushes every *file* offscreen. Names are
# prefixed ``00_seed_`` so they sort ahead of any ``e2e_fb_*`` entry (digits sort
# before letters), keeping the created/asserted entry reliably below the fold.
SEED_DIR_COUNT = 45
SEED_FILE_COUNT = 45


def _seed_workspace(workspace: Path) -> None:
    """Populate ``workspace`` with a virtualized-listing's worth of entries."""
    for i in range(SEED_DIR_COUNT):
        (workspace / f"00_seed_dir_{i:02d}").mkdir()
    for i in range(SEED_FILE_COUNT):
        (workspace / f"00_seed_file_{i:02d}.txt").touch()


@pytest.fixture(autouse=True)
def scratch_workspace(request):
    """A fresh, seeded temp dir per test — the browse target instead of ``$HOME``.

    Created and populated on the host filesystem (the app runs locally), exposed
    to the test as ``self._workspace`` (absolute path) and ``self._workspace_name``
    (its basename, used as the path-bar needle). Removed in ``finally`` so an
    interrupted or failing test leaves nothing behind — and never touches
    ``$HOME``.
    """
    workspace = Path(tempfile.mkdtemp(prefix="e2e_fb_"))
    _seed_workspace(workspace)
    request.instance._workspace = str(workspace)
    request.instance._workspace_name = workspace.name
    try:
        yield str(workspace)
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


class TestFileBrowserLocal(
    TerminalUi, TabsUi, SidebarUi, FilesUi, ShellFsUi, ConnectionsUi, SystemTest
):
    def _fresh_temp_browser(self) -> str:
        """Pristine app → terminal ``cd``'d into the seeded temp dir → Files sidebar.

        Restarting (rather than closing all tabs to zero) avoids the file browser
        being left on a stale directory when the active panel empties, so each
        test starts from the same clean listing. The browser follows the active
        terminal's CWD, so ``cd``-ing the terminal into the temp dir (with the
        browser hidden, then revealing it) points the browser there. Returns the
        displayed temp-dir path.
        """
        self.restart_app()
        self.ensure_terminal()
        # Keep the browser hidden while we cd; revealing it re-reads the CWD.
        self.switch_to_connections_sidebar()
        # Use forward slashes so the cd is valid regardless of which shell the
        # toolbar's new-terminal opened. On Windows the temp dir is a
        # backslash path (C:\Users\...\e2e_fb_*), and backslashes are escape
        # characters in a POSIX shell — so if the default terminal is Git Bash
        # the cd silently fails and the browser never follows there (#2683).
        # PowerShell also accepts forward slashes, and on macOS/Linux the path
        # has no backslashes, so this is a no-op off Windows.
        cd_target = self._workspace.replace("\\", "/")
        self.run_command(f'cd "{cd_target}"')
        self.switch_to_files_sidebar()
        return self.wait_for_path_contains(self._workspace_name)

    # ── MT-FB-01: Browse local files ────────────────────────────────────────
    def test_toolbar_is_visible_for_a_local_terminal(self):
        self._fresh_temp_browser()
        assert self.driver.exists(self.UP)
        assert self.driver.exists(self.REFRESH)
        self.switch_to_connections_sidebar()

    def test_shows_an_absolute_current_path(self):
        path = self._fresh_temp_browser()
        assert is_absolute_path(path)
        self.switch_to_connections_sidebar()

    def test_lists_entries_from_the_current_directory(self):
        self._fresh_temp_browser()
        sentinel = f"e2e_fb_{unique_name('entry')}.txt"
        # Created below the seeded fold, so this exercises the virtualization-aware
        # filter path in wait_for_file_row (the row is not initially mounted).
        (Path(self._workspace) / sentinel).touch()
        self.wait_for_file_row(sentinel)
        self.switch_to_connections_sidebar()

    # ── MT-FB-02: Navigate directories ──────────────────────────────────────
    def test_up_button_navigates_to_the_parent(self):
        before = self._fresh_temp_browser()
        after = self.navigate_up()
        assert after != before
        assert len(after) < len(before)  # parent is shorter than the temp-dir path
        self.switch_to_connections_sidebar()

    def test_double_click_enters_a_subdirectory(self):
        self._fresh_temp_browser()
        test_dir = f"e2e_fb_{unique_name('dir')}"
        inner = Path(self._workspace) / test_dir / "inner.txt"
        inner.parent.mkdir(parents=True, exist_ok=True)
        inner.touch()

        path = self.enter_directory(test_dir)
        assert test_dir in path
        self.wait_for_file_row("inner.txt")
        self.switch_to_connections_sidebar()

    def test_navigating_up_then_back_restores_the_directory(self):
        start = self._fresh_temp_browser()
        # Cross-platform basename — the displayed path uses "/" or "\".
        basename = start.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]
        self.navigate_up()
        restored = self.enter_directory(basename)
        assert restored == start
        self.switch_to_connections_sidebar()

    # ── CWD-aware browsing (PR #39) — exercises shell cwd-following ──────────
    def test_browser_follows_cd_in_the_terminal(self):
        target, needle = self.shell.scratch_dirs()[0]
        self.restart_app()
        self.ensure_terminal()
        self.open_file_browser()
        self.switch_to_connections_sidebar()  # return focus to the terminal
        self.run_command(f"cd {target}")
        self.switch_to_files_sidebar()
        assert needle in self.wait_for_path_contains(needle)
        self.switch_to_connections_sidebar()

    def test_cwd_survives_a_sidebar_view_round_trip(self):
        target, needle = self.shell.scratch_dirs()[0]
        self.restart_app()
        self.ensure_terminal()
        self.run_command(f"cd {target}")
        self.switch_to_files_sidebar()
        self.wait_for_path_contains(needle)
        # Switch away to connections and back to files; the path must be retained.
        self.switch_to_connections_sidebar()
        self.switch_to_files_sidebar()
        assert needle in self.wait_for_path_contains(needle)
        self.switch_to_connections_sidebar()

    def test_browser_follows_cwd_when_switching_between_two_shells(self):
        # PR #39 two-shell coverage (#873): the browser re-targets the *active*
        # terminal tab's cwd when you switch between two local shells sitting in
        # different directories. ``ShellCommands.scratch_dirs`` supplies two
        # distinct dirs + path substrings per platform (#902), each surviving the
        # macOS /private symlink and the Windows backslash→slash normalization.
        # Every assertion waits for the displayed path to settle, so it never
        # races the shell's OSC 7 / OSC 9;9 cwd emission (the timing that left
        # this unported).
        (target_a, needle_a), (target_b, needle_b) = self.shell.scratch_dirs()
        self.restart_app()
        self.ensure_terminal()
        tab1 = self.tab_ids()[0]
        self.open_file_browser()
        # Shell 1 → dir A (hide the browser, cd, reveal it — the proven recipe).
        self.switch_to_connections_sidebar()
        self.run_command(f"cd {target_a}")
        self.switch_to_files_sidebar()
        self.wait_for_path_contains(needle_a)
        # A second shell → dir B, opened from the terminal toolbar.
        before = self.tab_ids()
        self.switch_to_connections_sidebar()
        self.driver.click("terminal-view-new-terminal")
        self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a second terminal tab")
        tab2 = next(t for t in self.tab_ids() if t not in before)
        # The new terminal is active; wait for its own shell prompt, then cd it.
        self.wait(
            lambda: self.driver.read_terminal(tab2).strip() != "",
            what="the second shell's prompt",
        )
        self.run_command(f"cd {target_b}")
        self.switch_to_files_sidebar()
        assert needle_b in self.wait_for_path_contains(needle_b)
        # Switching the active tab back to shell 1 re-targets the browser to dir A …
        self.switch_to_tab(tab1)
        assert needle_a in self.wait_for_path_contains(needle_a)
        # … and forward to shell 2 back to dir B.
        self.switch_to_tab(tab2)
        assert needle_b in self.wait_for_path_contains(needle_b)
        self.switch_to_connections_sidebar()

    # ── New File / New Folder inline inputs (PR #58) ────────────────────────
    def test_new_folder_button_reveals_its_input(self):
        self._fresh_temp_browser()
        assert self.open_new_folder_input() is True
        self.cancel_inline_input()
        self.switch_to_connections_sidebar()

    def test_new_file_button_reveals_its_input(self):
        self._fresh_temp_browser()
        assert self.open_new_file_input() is True
        self.cancel_inline_input()
        self.switch_to_connections_sidebar()

    def test_create_file_via_inline_input(self):
        self._fresh_temp_browser()
        name = f"e2e_fb_{unique_name('newfile')}.txt"
        self.create_file_via_browser(name)
        assert self.file_row_exists(name)
        self.delete_entry(name)  # cleanup via the same context-menu delete path
        self.switch_to_connections_sidebar()

    def test_cancel_file_creation_with_escape(self):
        self._fresh_temp_browser()
        self.open_new_file_input()
        self.cancel_inline_input()
        self.wait(
            lambda: not self.driver.exists(self.NEW_FILE_INPUT),
            what="the new-file input to close",
        )
        self.switch_to_connections_sidebar()

    def test_create_folder_via_toolbar(self):
        self._fresh_temp_browser()
        name = f"e2e_fb_{unique_name('newdir')}"
        self.create_folder_via_browser(name)
        assert self.file_row_exists(name)
        self.delete_entry(name)
        self.switch_to_connections_sidebar()

    # ── Right-click context menu (PR #59) ───────────────────────────────────
    def test_file_context_menu_offers_edit_rename_delete(self):
        self._fresh_temp_browser()
        name = f"e2e_fb_{unique_name('ctx')}.txt"
        self.create_file_via_browser(name)
        self.open_file_menu(name)
        assert self.driver.exists("context-file-edit")
        assert self.driver.exists("context-file-rename")
        assert self.driver.exists("context-file-delete")
        self.dismiss_menu()
        self.delete_entry(name)
        self.switch_to_connections_sidebar()

    def test_context_menu_delete_removes_the_file(self):
        self._fresh_temp_browser()
        name = f"e2e_fb_{unique_name('del')}.txt"
        self.create_file_via_browser(name)
        assert self.file_row_exists(name)
        self.delete_entry(name)
        assert not self.file_row_exists(name)
        self.switch_to_connections_sidebar()

    # ── Multi-delete partial failure (#1348 / #1394) ────────────────────────
    @pytest.mark.skipif(
        sys.platform == "win32", reason="relies on POSIX directory permissions"
    )
    def test_multi_delete_continues_past_an_entry_that_cannot_be_deleted(self):
        """Ctrl/Cmd+A → Delete (3 items) with one folder the user may not empty.

        The folder is ``0500`` with a file inside, so removing it fails; the two
        plain files must still be deleted (every delete settles independently)
        and the failed folder must stay, contents intact.
        """
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            pytest.skip("root ignores directory permissions")
        self._fresh_temp_browser()
        prefix = f"e2e_fb_{unique_name('md')}_"
        workspace = Path(self._workspace)
        file_a = workspace / f"{prefix}a.txt"
        file_b = workspace / f"{prefix}b.txt"
        locked = workspace / f"{prefix}locked"
        file_a.write_text("a\n")
        file_b.write_text("b\n")
        locked.mkdir()
        (locked / "keep.txt").write_text("keep\n")
        locked.chmod(0o500)
        try:
            self.wait_for_file_row(locked.name)  # refreshes until the new entries list
            self.filter_entries(prefix)  # exactly the three entries under test
            self.wait(
                lambda: all(self.file_row_exists(p.name) for p in (file_a, file_b, locked)),
                what="the three entries under test",
            )
            # Select all (the filtered listing), then delete from the row menu.
            self.driver.press_key("a", file_row_testid(file_a.name), ctrl=True)
            self.driver.context_menu(file_row_testid(file_a.name))
            self.wait(
                lambda: self.driver.exists("multi-select-delete"),
                what="the multi-selection menu",
            )
            assert "3 items" in self.driver.get_text("multi-select-delete")
            self.driver.click("multi-select-delete")
            self.wait(
                lambda: self.driver.exists("confirm-delete-confirm"),
                what="the delete-confirm dialog",
            )
            self.driver.click("confirm-delete-confirm")

            self.wait(
                lambda: not file_a.exists() and not file_b.exists(),
                what="the deletable files to be removed despite the failure",
            )
            assert locked.is_dir() and (locked / "keep.txt").is_file()
            self.refresh_file_browser()
            self.wait(
                lambda: self.file_row_exists(locked.name)
                and not self.file_row_exists(file_a.name)
                and not self.file_row_exists(file_b.name),
                what="the listing to show only the folder that failed",
            )
        finally:
            locked.chmod(0o700)  # so the workspace teardown can remove it
        self.switch_to_connections_sidebar()

    # ── Drag-to-move (PROD-006, #3454) ──────────────────────────────────────
    def _drag_fixture(self, tag: str) -> tuple[Path, Path]:
        """A fresh browser listing a ``<prefix>dest`` folder and ``<prefix>file.txt``.

        Filters the listing to the pair so both rows are mounted side by side
        (the workspace is seeded past the virtualizer's window).
        """
        self._fresh_temp_browser()
        prefix = f"e2e_fb_{unique_name(tag)}_"
        workspace = Path(self._workspace)
        dest = workspace / f"{prefix}dest"
        source = workspace / f"{prefix}file.txt"
        dest.mkdir()
        source.write_text("drag me\n")
        self.wait_for_file_row(source.name)
        self.filter_entries(prefix)
        self.wait(
            lambda: self.file_row_exists(source.name) and self.file_row_exists(dest.name),
            what="the file and folder rows",
        )
        return source, dest

    def test_dragging_a_file_onto_a_folder_moves_it(self):
        """A pointer drag of a file row released on a folder row moves the file.

        ``drag_to`` drives dnd-kit's PointerSensor past its 8px activation
        distance and releases over the folder row; a plain drag (no Alt) is a
        move, so the file leaves the workspace and lands in the folder intact.
        While the pointer hovers the folder (``observe``), the row is highlighted
        as a valid drop and the chip says "Move".
        """
        source, dest = self._drag_fixture("dm")
        dest_row = file_row_testid(dest.name)

        seen = self.driver.drag_to(
            file_row_testid(source.name), dest_row, observe=[dest_row, DRAG_CHIP]
        )

        assert seen[dest_row]["attributes"].get("data-drop-highlight") == "valid"
        assert seen[DRAG_CHIP]["exists"], "no drag chip while dragging"
        assert seen[DRAG_CHIP]["text"] == f'Move "{source.name}"'
        moved = dest / source.name
        self.wait(
            lambda: moved.is_file() and not source.exists(),
            what="the file to move into the folder",
        )
        assert moved.read_text() == "drag me\n"
        self.refresh_file_browser()
        self.wait(
            lambda: not self.file_row_exists(source.name),
            what="the moved file to leave the listing",
        )
        self.switch_to_connections_sidebar()

    def test_dropping_a_file_on_a_breadcrumb_moves_it_up(self):
        """A file dragged onto an ancestor's breadcrumb segment moves up into it."""
        self._fresh_temp_browser()
        prefix = f"e2e_fb_{unique_name('dc')}_"
        workspace = Path(self._workspace)
        sub = workspace / f"{prefix}sub"
        source = sub / f"{prefix}file.txt"
        sub.mkdir()
        source.write_text("drag me up\n")
        self.enter_directory(sub.name)
        self.wait_for_file_row(source.name)
        crumb = f"file-browser-crumb-{self._workspace_name}"
        self.wait(lambda: self.driver.exists(crumb), what="the workspace's breadcrumb")

        seen = self.driver.drag_to(file_row_testid(source.name), crumb, observe=[crumb])

        assert seen[crumb]["attributes"].get("data-drop-highlight") == "valid"
        moved = workspace / source.name
        self.wait(
            lambda: moved.is_file() and not source.exists(),
            what="the file to move up into the workspace",
        )
        assert moved.read_text() == "drag me up\n"
        self.switch_to_connections_sidebar()

    def test_dropping_a_folder_on_itself_is_refused(self):
        """A folder dragged onto its own row turns it red and moves nothing."""
        _, dest = self._drag_fixture("ds")
        (dest / "inside.txt").write_text("stay\n")
        dest_row = file_row_testid(dest.name)

        seen = self.driver.drag_to(dest_row, dest_row, observe=[dest_row])

        assert seen[dest_row]["attributes"].get("data-drop-highlight") == "invalid"
        # Give a (wrongly) accepted move time to land before asserting it did not.
        self.refresh_file_browser()
        self.wait(lambda: self.file_row_exists(dest.name), what="the folder row to list")
        assert dest.is_dir() and (dest / "inside.txt").read_text() == "stay\n"
        assert not (dest / dest.name).exists()
        self.switch_to_connections_sidebar()

    def test_alt_dragging_a_file_onto_a_folder_copies_it(self):
        """Holding Alt for the drag copies the file: it stays and a twin lands."""
        source, dest = self._drag_fixture("da")
        dest_row = file_row_testid(dest.name)

        seen = self.driver.drag_to(
            file_row_testid(source.name), dest_row, alt=True, observe=[DRAG_CHIP]
        )

        assert seen[DRAG_CHIP]["text"] == f'Copy "{source.name}"'
        copied = dest / source.name
        self.wait(lambda: copied.is_file(), what="the copy to land in the folder")
        self.wait(
            lambda: copied.read_text() == "drag me\n", what="the copy to finish writing"
        )
        assert source.is_file() and source.read_text() == "drag me\n"
        self.switch_to_connections_sidebar()
