"""Guided-manual app lifecycle and OS-integration checks (#913).

Ported from the retired ``tests/manual/{app,multi-window,shell-integration,
file-browser}.yaml``. Each item ends in something only the OS owns: the macOS
Dock and app menu, an Explorer / Finder / file-manager context menu, a
MobaXterm install. The harness builds the in-app state (shells, the
spawn request through the instance's private rendezvous) and the operator does
and judges the OS-side step.

Covered: MT-APP-03, MT-APP-05, MT-SHI-01, MT-SHI-03..06.
(MT-WIN-01..04, the macOS Dock and quit paths, and MT-SHI-02, external spawn
raising the window, are graded with real OS events aimed at the test
instance's PID by ``test_os_input_macos_app.py`` / ``test_os_input_keyboard.py``
since #4935 — never by app name.)
(MT-FB-32, open in file manager, is graded by ``test_external_app_handoffs.py``
since #4932; MT-FB-30, the 5000-file folder, by ``test_os_file_drop.py`` and
MT-FB-31, dragging rows out to the OS, by ``test_os_file_drop_xdnd.py`` since
#4936.)
(MT-APP-02, the production CSP, and MT-APP-04, single instance, are graded on
the shipped artifacts by the release install smokes since #4933.)

Run with ``./pytest.sh --manual -k guided_app_os -s``.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

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
)

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

