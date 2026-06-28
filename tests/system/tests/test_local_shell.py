"""Local shell connections: spawn, input, starting directory, splits, exit.

Ported from ``tests/e2e/local-shell.test.js`` and
``local-shell-extended.test.js`` onto the Python bridge harness (#809).

Where the old WebdriverIO tests could only assert "the xterm container still
exists" (they couldn't read the GPU canvas), the bridge reads the reconstructed
terminal text, so these assert the **actual** behavior: that ``pwd`` lands in the
configured directory, that input is delivered, and that the shell exits. Starting
-directory and home checks use a shell-level marker built by ``ShellCommands``
(POSIX ``[ "$(pwd)" = … ] && echo OK`` or the PowerShell equivalent), so they run
cross-platform and survive the ``/tmp`` ↔ ``/private/tmp`` symlink (#902).
"""

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    LayoutUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.shell import ShellCommands, is_absolute_path

pytestmark = pytest.mark.integration

# Starting-directory cases for test_starting_directory_is_applied, built for the
# host's shell: one absolute directory plus the home-resolving start values, each
# paired with the marker command that confirms the shell landed there.
_SH = ShellCommands.for_host()
_STARTING_DIR_CASES = [
    ("dir-abs", _SH.starting_dir(), _SH.starting_dir_pwd_marker("START_DIR_OK")),
    *[
        (f"dir-home-{i}", value, _SH.home_pwd_marker("START_DIR_OK"))
        for i, value in enumerate(_SH.home_start_values())
    ],
]


class TestLocalShell(
    TerminalUi, TabsUi, LayoutUi, SidebarUi, FilesUi, ShellFsUi, ConnectionsUi, SystemTest
):
    # ── LOCAL-02 / baseline: spawn + run commands ───────────────────────────
    def test_connecting_opens_an_active_terminal_tab(self):
        self.close_all_tabs()
        name = unique_name("shell")
        self.create_local_connection(name)
        self.switch_to_connections_sidebar()
        self.connect_connection(name)

        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} terminal tab")
        assert tab is not None
        active = self.active_tab()
        assert active is not None and name in (active.get("title") or "")
        # The bridge can read the buffer, so prove the shell actually started.
        self.wait(self.has_terminal, what="the shell to be readable")

    def test_terminal_runs_commands(self):
        self.close_all_tabs()
        name = unique_name("baseline-cmd")
        self.create_local_connection(name)
        self.switch_to_connections_sidebar()
        self.connect_connection(name)

        marker = "E2E_LOCAL_MARKER"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def test_shell_dropdown_offers_a_shell(self):
        # The Local editor's shell <select> is pre-populated with the OS's
        # available shells, so a non-empty current value means at least one exists.
        self.open_new_connection_editor()
        self.wait(lambda: self.driver.exists("field-shell"), what="the shell dropdown")
        assert self.driver.get_value("field-shell") != ""
        self.driver.click(self.EDITOR_CANCEL)

    # ── Configurable starting directory (PR #148) ───────────────────────────
    @pytest.mark.parametrize("purpose, start_dir, pwd_check", _STARTING_DIR_CASES)
    def test_starting_directory_is_applied(self, purpose, start_dir, pwd_check):
        self.close_all_tabs()
        name = unique_name(purpose)
        self.create_local_connection(name, starting_directory=start_dir, connect=True)
        # pwd_check already echoes START_DIR_OK only when the cwd matches.
        self.run_command(pwd_check)
        assert "START_DIR_OK" in self.wait_for_output("START_DIR_OK")

    def test_starting_directory_applied_when_editing_a_connection(self):
        self.close_all_tabs()
        name = unique_name("dir-edit")
        self.create_local_connection(name)
        # Reopen the saved connection in the editor and add a starting directory.
        self.connection_context_action(name, self.CTX_EDIT)
        self.wait(
            lambda: self.driver.exists("field-startingDirectory"),
            what="the editor starting-directory field",
        )
        self.driver.type("field-startingDirectory", self.shell.starting_dir())
        self.driver.click(self.EDITOR_SAVE)
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.run_command(self.shell.starting_dir_pwd_marker("EDIT_DIR_OK"))
        assert "EDIT_DIR_OK" in self.wait_for_output("EDIT_DIR_OK")

    # ── New tabs open in the home directory (PR #66) ────────────────────────
    def test_new_terminal_starts_in_home(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(self.shell.home_pwd_marker("NEW_TAB_HOME_OK"))
        assert "NEW_TAB_HOME_OK" in self.wait_for_output("NEW_TAB_HOME_OK")

    def test_file_browser_shows_home_for_a_new_shell(self):
        self.close_all_tabs()
        self.ensure_terminal()
        path = self.open_file_browser()
        # The local browser follows the shell's CWD: an absolute home-like path.
        assert is_absolute_path(path)
        self.switch_to_connections_sidebar()

    # ── Terminal input on new connections (PR #198) ─────────────────────────
    def test_rapidly_created_terminals_accept_input(self):
        self.close_all_tabs()
        names = [unique_name(f"rapid-{i}") for i in range(3)]
        for name in names:
            self.create_local_connection(name)
            self.switch_to_connections_sidebar()
            self.connect_connection(name)

        assert self.tab_count() >= 3
        # Each terminal must independently accept input and echo it back.
        for name in names:
            tab = self.wait(lambda n=name: self.find_tab(n), what=f"tab {name!r}")
            self.switch_to_tab(tab["id"])
            marker = f"INPUT_{name[-8:]}"
            self.run_command(f"echo {marker}")
            assert marker in self.wait_for_output(marker, tab_id=tab["id"])

    def test_input_reaches_both_panels_after_a_split(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.driver.click("terminal-view-split-horizontal")
        self.wait(lambda: self.leaf_count() >= 2, what="the view to split into two leaves")
        # A terminal in the freshly-split (active) panel must accept input.
        self.ensure_terminal()
        marker = "SPLIT_PANEL_OK"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)
        assert self.leaf_count() == 2

    # ── Baseline: exit ──────────────────────────────────────────────────────
    def test_typing_exit_ends_the_session(self):
        self.close_all_tabs()
        name = unique_name("baseline-exit")
        self.create_local_connection(name)
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")

        self.run_command("exit")
        # The store flags an exited terminal; that drives the "[Process exited]"
        # overlay the old test could not read off the canvas.
        self.wait(
            lambda: self._terminal_exited(tab["id"]),
            what="the terminal to report it exited",
        )

    def _terminal_exited(self, tab_id: str) -> bool:
        from termihub_harness import BridgeError

        try:
            return bool(self.driver.get_state(f"terminalExitedTabs.{tab_id}"))
        except BridgeError:
            return False
