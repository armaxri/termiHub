"""Guided-manual app lifecycle and OS-integration checks (#913).

Ported from the retired ``tests/manual/{app,multi-window,shell-integration,
file-browser}.yaml``. Each item ends in something only the OS owns: the macOS
Dock and app menu, an Explorer / Finder / file-manager context menu, a real OS
drag, a MobaXterm install. The harness builds the in-app state (shells, a
5000-file folder, the spawn request through the instance's private rendezvous)
and the operator does and judges the OS-side step.

Covered: MT-APP-05, MT-SHI-01, MT-SHI-03..06, MT-FB-30/31.
(MT-WIN-01..04, the macOS Dock and quit paths, and MT-SHI-02, external spawn
raising the window, are graded with real OS events aimed at the test
instance's PID by ``test_os_input_macos_app.py`` / ``test_os_input_keyboard.py``
since #4935 — never by app name.)
(MT-SHI-04..06 are one glance each: their OS artifacts are asserted by
``test_shell_integration_artifacts.py`` since #4963.)
(MT-FB-32, open in file manager, is graded by ``test_external_app_handoffs.py``
since #4932.)
(MT-APP-03, plugin index and install from URL over real HTTPS, runs unattended
in the nightly lane in ``test_plugin_discovery_https.py`` since #4961.)
(MT-APP-02, the production CSP, and MT-APP-04, single instance, are graded on
the shipped artifacts by the release install smokes since #4933.)

Run with ``./pytest.sh --manual -k guided_app_os -s``.
"""

from __future__ import annotations

import shutil
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
    # The artifacts Install writes and Uninstall removes (HKCU keys, Quick Action
    # bundles, Nautilus/Dolphin/Thunar/XDG entries, foreign entries kept) are
    # asserted by test_shell_integration_artifacts.py (#4963), and the click →
    # spawn path by test_external_spawn.py. What stays is one glance: the OS
    # file manager actually renders the menu from them. This writes the real
    # per-user registration and uninstalls it again afterwards.
    def _glance_at_context_menu(self, where: str) -> None:
        self.open_settings_category("shell-integration")
        self.driver.click("shell-integration-add-entry")
        self.wait(
            lambda: self.driver.exists("shell-integration-entry-save"),
            what="the Add Entry dialog",
        )
        self.driver.click("shell-integration-entry-save")
        self.driver.click("shell-integration-reinstall")
        self.wait(
            lambda: self.driver.get_text("shell-integration-status-text") == "Registered",
            what="Registered after Install",
        )
        try:
            self.manual_step(
                f"The harness installed an 'Open in termiHub' entry for folders. {where}",
                "'Open in termiHub' is listed (with the termiHub icon).",
            )
        finally:
            self.driver.click("shell-integration-uninstall")

    @pytest.mark.manual(platforms=["windows"])
    def test_explorer_shows_and_removes_open_in_termihub(self):
        """MT-SHI-04 (glance; artifacts automated, #4963)."""
        self._glance_at_context_menu("In Explorer right-click a folder.")

    @pytest.mark.manual(platforms=["macos"])
    def test_macos_finder_quick_actions_and_services(self):
        """MT-SHI-05 (glance; artifacts automated, #4963)."""
        self._glance_at_context_menu(
            "In Finder right-click a folder > Quick Actions (run "
            "`/System/Library/CoreServices/pbs -flush` first if it is missing)."
        )

    @pytest.mark.manual(platforms=["linux"])
    def test_linux_file_managers_show_and_run_open_in_termihub(self):
        """MT-SHI-06 (glance; artifacts automated, #4963)."""
        self._glance_at_context_menu(
            "Right-click a folder in your file manager > Open With (Other "
            "Application); the Nautilus/Dolphin/Thunar menus also need their "
            "toggles on the Shell Integration page."
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

