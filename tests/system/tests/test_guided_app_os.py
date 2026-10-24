"""Guided-manual app lifecycle and OS-integration checks (#913).

Ported from the retired ``tests/manual/{app,multi-window,shell-integration,
file-browser}.yaml``. Each item ends in something only the OS owns: the macOS
Dock and app menu, an Explorer / Finder / file-manager context menu, a real OS
drag, a MobaXterm install. The harness builds the in-app state (shells, an
unsaved editor, a 5000-file folder, the spawn request through the instance's
private rendezvous) and the operator does and judges the OS-side step.

**Never quit termiHub by name.** The operator usually runs an installed termiHub
beside the test instance. The harness never sends a by-name quit; the steps
that would (AppleScript ``quit app "termiHub"``, Log Out) first check for
another termiHub process (:func:`termihub_harness.guided.running_other_termihub_pids`)
and are skipped while one runs.

Covered: MT-APP-03, MT-APP-05, MT-WIN-01..04, MT-SHI-01..06, MT-FB-30/31.
(MT-FB-32, open in file manager, is graded by ``test_external_app_handoffs.py``
since #4932.)
(MT-APP-02, the production CSP, and MT-APP-04, single instance, are graded on
the shipped artifacts by the release install smokes since #4933.)

Run with ``./pytest.sh --manual -k guided_app_os -s``.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import psutil
import pytest

from termihub_harness import (
    ConnectionsUi,
    EditorUi,
    FilesUi,
    ManualUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WindowsUi,
    unique_name,
)
from termihub_harness.guided import running_other_termihub_pids

pytestmark = [pytest.mark.integration, pytest.mark.manual]


class TestGuidedAppOs(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    FilesUi,
    EditorUi,
    WindowsUi,
    ManualUi,
    SystemTest,
):
    """Harness builds the state; operator drives and judges the OS side."""

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _own_pids(self) -> list[int]:
        pid = self.app.pid
        if pid is None:
            return []
        try:
            return [pid, *(c.pid for c in psutil.Process(pid).children(recursive=True))]
        except psutil.Error:
            return [pid]

    def _skip_if_other_termihub(self, step: str) -> None:
        """Skip a by-name quit step while another termiHub (e.g. installed) runs."""
        others = running_other_termihub_pids(self._own_pids())
        if others:
            pytest.skip(
                f"{step} would also quit the other termiHub running as PID(s) "
                f"{others}; quit that one first to run this step"
            )

    def _shell_and_unsaved_editor(self) -> None:
        """One local shell tab plus an editor tab with an unsaved change."""
        self.close_all_tabs()
        self.ensure_terminal()
        name = f"{unique_name('unsaved')}.txt"
        self.open_file_browser()
        self.create_file_via_browser(name)
        self.open_file_in_editor(name)
        self.dirty_editor()

    def _relaunch(self) -> None:
        """Bring the test instance back after the operator quit it."""
        self.restart_app()

    # ── MT-APP-03: plugin install over real HTTPS (macOS) ────────────────────
    @pytest.mark.manual(platforms=["macos"])
    def test_plugin_index_and_url_install_over_real_https(self):
        """MT-APP-03."""
        self.open_settings_category("plugins")
        self.manual_step(
            "Settings > Plugins > Browse Plugins > Load plugin index. Under Install from "
            "URL, paste a GitHub-hosted clock-widget URL with its SHA-256.",
            "The default index loads from main (no HTTP 404); the install dialog opens "
            "with the unsigned banner and nothing installs before you confirm.",
        )

    # ── MT-APP-05: MobaXterm import (Windows) ────────────────────────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_mobaxterm_import_finds_installed_configuration(self):
        """MT-APP-05."""
        self.manual_step(
            "Install MobaXterm (installed edition) and save: an SSH session with a "
            "private key, a Telnet and a Serial session (one in a sub-folder) and a "
            "Browser session. Close MobaXterm.",
            "Sessions saved.",
        )
        self.open_settings_category("import")
        self.manual_step(
            "Click Import from MobaXterm…, select all, pick a target folder and Import. "
            "Then Choose another file… and pick a .mxtsessions export of the same sessions.",
            "The page names %APPDATA%\\MobaXterm\\MobaXterm.ini and the dialog previews it "
            "without picking; each session shows type/target/folder and the Browser one is "
            "under Not imported; the tree lands under the target with real key paths (no "
            "_ProfileDir_) and no passwords; the .mxtsessions file previews the same.",
        )

    # ── MT-WIN-01..04: macOS Dock and quit paths ─────────────────────────────
    @pytest.mark.manual(platforms=["macos"])
    def test_macos_last_window_close_keeps_app_in_dock(self):
        """MT-WIN-01."""
        self.close_all_tabs()
        self.open_new_window()
        self.manual_step(
            f"Two termiHub windows are open (test instance, PID {self.app.pid}). Close "
            "the second with its title-bar button, then close the last one. Click this "
            "instance's Dock icon.",
            "Each close removes only that window; after the last the app keeps its "
            "running dot; the Dock click recreates a window.",
        )
        self._relaunch()

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_cmd_q_quits_with_several_windows(self):
        """MT-WIN-02."""
        self.close_all_tabs()
        self.ensure_terminal()
        second = self.open_new_window()
        second.click("terminal-view-new-terminal")
        self.manual_step(
            "With the test instance focused, press Cmd+Q and in 'Quit termiHub?' choose "
            "'Quit & end sessions'.",
            "Every window closes and the Dock icon loses its running dot.",
        )
        self.wait(lambda: not self.app.is_running(), timeout=30.0, what="the app to quit")
        self._relaunch()
        self.manual_observe(
            "The harness relaunched the app.",
            "It starts cleanly: no leftover windows or orphaned sessions.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_cmd_q_with_live_shell_asks_first(self):
        """MT-WIN-03."""
        self._shell_and_unsaved_editor()
        self.manual_step(
            "Press Cmd+Q; while the dialog is open press Cmd+Q again; click Cancel. Then "
            "choose termiHub > Quit termiHub and click 'Quit & end sessions'.",
            "The dialog lists the shell and the unsaved editor; the second Cmd+Q does "
            "nothing; Cancel keeps the shell running; the menu Quit opens the same dialog "
            "and confirming quits.",
        )
        self.wait(lambda: not self.app.is_running(), timeout=30.0, what="the app to quit")
        self._relaunch()
        self.manual_step(
            "Close every window of the relaunched app (it stays in the Dock), then press "
            "Cmd+Q.",
            "It quits at once without a dialog.",
        )
        self._relaunch()

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_dock_quit_and_applescript_quit_ask_first(self):
        """MT-WIN-04. The AppleScript and Log Out steps quit termiHub by name."""
        self._shell_and_unsaved_editor()
        self.manual_step(
            "Right-click this instance's Dock icon, choose Quit, then click Cancel.",
            "The same 'Quit termiHub?' dialog opens; after Cancel the app and shell keep "
            "running.",
        )
        self._skip_if_other_termihub("AppleScript quit app \"termiHub\"")
        self.manual_step(
            "In Terminal.app run: osascript -e 'quit app \"termiHub\"', click Cancel; run "
            "it again and click 'Quit & end sessions'.",
            "The same dialog opens; Cancel keeps the app running; confirming quits.",
        )
        self.wait(lambda: not self.app.is_running(), timeout=30.0, what="the app to quit")
        self._relaunch()
        self._shell_and_unsaved_editor()
        self.manual_step(
            "Only if nothing else needs this login session: choose Apple menu > Log Out "
            "and confirm, then log back in (skip with s otherwise).",
            "Log Out does not wait on a termiHub dialog and no 'termiHub cancelled "
            "logout' message appears.",
        )

    # ── MT-SHI-01..03: external spawn ────────────────────────────────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_spawn_picker_wsl_section_and_distro_pick(self):
        """MT-SHI-01 (two or more WSL distributions installed)."""
        location = tempfile.mkdtemp(prefix="thub-spawn-")
        self.app.run_cli(["spawn", "--location", location, "--pick"])
        self.manual_step(
            "The harness ran `termiHub spawn --pick` for this instance. In the picker "
            "pick a non-default WSL distribution and press Open; run `cat /etc/os-release` "
            "and `pwd`.",
            "The WSL section lists every distribution; the tab runs the picked one and "
            f"`pwd` shows the /mnt/ form of {location}.",
        )

    def test_external_spawn_brings_window_to_front(self):
        """MT-SHI-02 (on Linux run once under X11 and once under Wayland)."""
        self.close_all_tabs()
        self.manual_step(
            "Put another app's window in front of termiHub, then answer y.",
            "termiHub is behind another window.",
        )
        self.app.run_cli(["spawn", "--location", str(Path.home())])
        self.manual_observe(
            "The harness ran `termiHub spawn --location ~` for this instance.",
            "The termiHub window came to the foreground with a focused '(Spawned)' local "
            "shell tab.",
        )

    @pytest.mark.manual(platforms=["windows"])
    def test_external_wsl_spawn_opens_named_distro_at_mnt_path(self):
        """MT-SHI-03 (a saved WSL connection for a non-default distro)."""
        home = str(Path.home())
        self.app.run_cli(["spawn", "--kind", "wsl", "--location", home])
        self.manual_step(
            f"The harness spawned a WSL tab at {home}. Run `pwd` in it. Then save a WSL "
            "connection named 'shi03' for a non-default distro (e.g. Debian).",
            "The tab is '(Spawned)' and pwd is /mnt/c/Users/<you>; 'shi03' is saved.",
        )
        conn = self.wait(lambda: self.find_connection("shi03"), what="the 'shi03' connection")
        self.app.run_cli(["spawn", "--kind", "wsl", "--location", home, "--connection", conn["id"]])
        self.manual_observe(
            "The harness spawned again with --connection shi03.",
            "The new '(Spawned)' tab runs the saved distro (`cat /etc/os-release`).",
        )

    # ── MT-SHI-04..06: OS context-menu integration ───────────────────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_explorer_shows_and_removes_open_in_termihub(self):
        """MT-SHI-04."""
        self.open_settings_category("shell-integration")
        self.manual_step(
            "Add 3 entries (one Extended, one with Files target) and Install. In "
            "Explorer right-click a folder, the folder background and a file, also with "
            "Shift; click an entry. Then Uninstall and right-click again.",
            "No UAC prompt; entries sit in one termiHub submenu, Extended only on Shift; "
            "the app comes forward with a tab cd'd there (file: its parent); after "
            "uninstall no entry remains.",
        )

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_finder_quick_actions_and_services(self):
        """MT-SHI-05 (termiHub.app installed in /Applications)."""
        self.open_settings_category("shell-integration")
        self.manual_step(
            "Install an entry with Folders + Files. In Finder right-click a folder > "
            "Quick Actions (enable under Keyboard > Services; `pbs -flush` if missing) and "
            "run it on a folder, a file and three items, and via the Services menu. Then "
            "Uninstall and right-click again.",
            "No password prompt; the entry is under Quick Actions and Services; one "
            "session per item cd'd to the folder (file: its location); after uninstall "
            "only termiHub's Quick Action is gone.",
        )

    @pytest.mark.manual(platforms=["linux"])
    def test_linux_file_managers_show_and_run_open_in_termihub(self):
        """MT-SHI-06 (Nautilus, Dolphin and/or Thunar)."""
        self.open_settings_category("shell-integration")
        self.manual_step(
            "Install, then right-click a folder in each manager (Files: Scripts; "
            "Dolphin: Actions; Thunar; Open With) and run the entry. Uninstall and "
            "right-click again.",
            "No sudo prompt; only detected managers get the entry with the termiHub "
            "icon; the app focuses with a tab cd'd there; after uninstall all artifacts "
            "are gone and your own actions/scripts remain.",
        )

    # ── MT-FB-30..32: file browser and the OS file manager ───────────────────
    def test_large_directory_scrolls_and_accepts_os_drop(self):
        """MT-FB-30."""
        folder = Path(tempfile.mkdtemp(prefix="thub-5000-"))
        try:
            for i in range(5000):
                (folder / f"file-{i:05d}.txt").write_text("x", encoding="utf-8")
            self.close_all_tabs()
            self.ensure_terminal()
            self.run_command(f'cd "{folder}"')
            self.open_file_browser()
            self.wait_for_path_contains(folder.name, timeout=60.0)
            self.manual_step(
                f"The file browser shows {folder} (5000 files). Scroll top to bottom "
                "quickly, then drag a file from Finder/Explorer/Files onto the list.",
                "Scrolling is smooth with one scrollbar and no freeze; the dropped file "
                "is copied into the folder.",
            )
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def test_drag_files_out_to_the_os_file_manager(self):
        """MT-FB-31 (on Linux run under X11 and under Wayland)."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_file_browser()
        self.manual_step(
            "Drag a local file, then a file+folder selection, onto the desktop. In an "
            "SFTP session drag a remote folder out, hold until staged, drop. Repeat with "
            "a file from a Docker or agent session.",
            "Each drag lands a copy with its name; remote folders land with their full "
            "tree; the originals stay.",
        )

