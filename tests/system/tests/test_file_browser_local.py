"""Local file browser: browse, navigate, create, context menu, CWD-awareness.

Ported from ``tests/e2e/file-browser-local.test.js`` and
``file-browser-extended.test.js`` onto the Python bridge harness (#809).

The browser is driven through its real toolbar/row testids and asserted against
what the user sees — ``file-browser-current-path`` (the breadcrumb path bar,
read via its ``title``) for the path and ``file-row-<name>`` for entries. Known entries are created in the browser's
**current** directory (the home dir a fresh shell shows) or via the browser's own
New File/Folder inputs, so a test never depends on OSC 7 cwd-following timing for
its fixtures. The dedicated CWD-aware tests below *do* exercise cwd-following and
wait for the displayed path to settle.

Not ported (kept as manual tests in docs/testing.md): three-dots row-menu vs
context-menu styling parity and other pure-visual checks; the rename inline-input
flow (covered indirectly — delete exercises the same context-menu refresh path).
"""

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.shell import is_absolute_path

pytestmark = pytest.mark.integration


class TestFileBrowserLocal(
    TerminalUi, TabsUi, SidebarUi, FilesUi, ShellFsUi, ConnectionsUi, SystemTest
):
    def _fresh_home_browser(self) -> str:
        """Pristine app → terminal + Files sidebar showing home; return its path.

        Restarting (rather than closing all tabs to zero) avoids the file browser
        being left on a stale directory when the active panel empties, so each
        test starts from the same clean home-directory listing.
        """
        self.restart_app()
        self.ensure_terminal()
        return self.open_file_browser()

    # ── MT-FB-01: Browse local files ────────────────────────────────────────
    def test_toolbar_is_visible_for_a_local_terminal(self):
        self._fresh_home_browser()
        assert self.driver.exists(self.UP)
        assert self.driver.exists(self.REFRESH)
        self.switch_to_connections_sidebar()

    def test_shows_an_absolute_current_path(self):
        path = self._fresh_home_browser()
        assert is_absolute_path(path)
        self.switch_to_connections_sidebar()

    def test_lists_entries_from_the_current_directory(self):
        self._fresh_home_browser()
        sentinel = f"e2e_fb_{unique_name('entry')}.txt"
        self.touch_home(sentinel)
        self.wait_for_file_row(sentinel)
        self.remove_home(sentinel)
        self.switch_to_connections_sidebar()

    # ── MT-FB-02: Navigate directories ──────────────────────────────────────
    def test_up_button_navigates_to_the_parent(self):
        before = self._fresh_home_browser()
        after = self.navigate_up()
        assert after != before
        assert len(after) < len(before)  # parent is shorter than the home path
        self.switch_to_connections_sidebar()

    def test_double_click_enters_a_subdirectory(self):
        self._fresh_home_browser()
        test_dir = f"e2e_fb_{unique_name('dir')}"
        self.make_home_dir(test_dir)
        self.touch_home(f"{test_dir}/inner.txt")

        path = self.enter_directory(test_dir)
        assert test_dir in path
        self.wait_for_file_row("inner.txt")
        self.remove_home_tree(test_dir)
        self.switch_to_connections_sidebar()

    def test_navigating_up_then_back_restores_the_directory(self):
        start = self._fresh_home_browser()
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
        self._fresh_home_browser()
        assert self.open_new_folder_input() is True
        self.cancel_inline_input()
        self.switch_to_connections_sidebar()

    def test_new_file_button_reveals_its_input(self):
        self._fresh_home_browser()
        assert self.open_new_file_input() is True
        self.cancel_inline_input()
        self.switch_to_connections_sidebar()

    def test_create_file_via_inline_input(self):
        self._fresh_home_browser()
        name = f"e2e_fb_{unique_name('newfile')}.txt"
        self.create_file_via_browser(name)
        assert self.file_row_exists(name)
        self.delete_entry(name)  # cleanup via the same context-menu delete path
        self.switch_to_connections_sidebar()

    def test_cancel_file_creation_with_escape(self):
        self._fresh_home_browser()
        self.open_new_file_input()
        self.cancel_inline_input()
        self.wait(
            lambda: not self.driver.exists(self.NEW_FILE_INPUT),
            what="the new-file input to close",
        )
        self.switch_to_connections_sidebar()

    def test_create_folder_via_toolbar(self):
        self._fresh_home_browser()
        name = f"e2e_fb_{unique_name('newdir')}"
        self.create_folder_via_browser(name)
        assert self.file_row_exists(name)
        self.delete_entry(name)
        self.switch_to_connections_sidebar()

    # ── Right-click context menu (PR #59) ───────────────────────────────────
    def test_file_context_menu_offers_edit_rename_delete(self):
        self._fresh_home_browser()
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
        self._fresh_home_browser()
        name = f"e2e_fb_{unique_name('del')}.txt"
        self.create_file_via_browser(name)
        assert self.file_row_exists(name)
        self.delete_entry(name)
        assert not self.file_row_exists(name)
        self.switch_to_connections_sidebar()
