"""Windows shell selection (PowerShell, cmd.exe, Git Bash) and WSL sessions.

Ported from ``tests/e2e/infrastructure/windows-shells.test.js`` (MT-LOCAL-02, 04,
06, 11..20) onto the Python bridge harness (#975, part of #803 / epic #799).

**Windows-only.** These exercise ConPTY and Windows-native shells/WSL, so the
whole module skips on non-Windows hosts (the inverse of the ``skip_on_windows``
pattern in :mod:`test_cross_platform`). The bridge runs natively on Windows (no
``tauri-driver``), so this suite runs in Windows CI (#804) where the WebdriverIO
spec could not run reliably.

Where the old WebdriverIO tests could only assert "the ``.xterm`` element still
exists" (they could not read the GPU canvas), the bridge reads the reconstructed
terminal buffer — so these assert the **actual** behavior: a selected shell
spawns, accepts input, and echoes a marker; the editor defaults to PowerShell;
and the WSL file browser follows the shell's cwd.

**Architectural divergence from the old spec.** The old MT-LOCAL-11/12 cases
assumed WSL distributions appear *inside the Local shell dropdown*. The codebase
since moved WSL to a **dedicated, Windows-only ``wsl`` connection type** (see
``core/src/backends/wsl.rs`` and ``src-tauri/src/session/registry.rs``), with its
own ``field-distribution`` selector — so the Local dropdown lists only the
Windows shells (``powershell``/``cmd``/``gitbash``) and WSL is created from its
own type. These tests follow the code: the Local-dropdown checks assert the
Windows shells, and the WSL cases drive the ``wsl`` type. WSL cases skip cleanly
when no WSL2 distribution is installed (mirroring the backend's own detection).
"""

from __future__ import annotations

import re
import sys

import pytest

from termihub_harness import (
    ConnectionsUi,
    FilesUi,
    LayoutUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.shell import is_absolute_path
from termihub_harness.wsl import detect_wsl_distros

pytestmark = pytest.mark.integration

_IS_WINDOWS = sys.platform.startswith("win")

skip_on_non_windows = pytest.mark.skipif(
    not _IS_WINDOWS, reason="Windows shells and WSL are a Windows-only feature"
)

# Probe the host once at import (cheap, cached) so WSL cases skip when WSL2 is
# absent — the same `wsl.exe --list --quiet` the backend uses to populate the
# distribution dropdown, so the gate and the app agree on availability.
_WSL_DISTROS = detect_wsl_distros() if _IS_WINDOWS else []
_WSL_DISTRO = _WSL_DISTROS[0] if _WSL_DISTROS else None

skip_without_wsl = pytest.mark.skipif(
    not _WSL_DISTROS, reason="no WSL2 distribution installed on this host"
)


@skip_on_non_windows
class TestWindowsShells(
    TerminalUi, TabsUi, LayoutUi, SidebarUi, FilesUi, ConnectionsUi, SystemTest
):
    """PowerShell / cmd.exe selection, rendering, input, and the shell selector."""

    # ── MT-LOCAL-02/14: a saved PowerShell connection spawns and accepts input ──
    def test_powershell_session_renders_and_accepts_input(self):
        self.close_all_tabs()
        name = unique_name("win-powershell")
        self.create_local_connection(name, shell="powershell")
        self.switch_to_connections_sidebar()
        self.connect_connection(name)

        self.wait(self.has_terminal, what="the PowerShell shell to be readable")
        marker = "WIN_PS_MARKER"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    # ── WIN-SHELL-02: a saved cmd.exe connection spawns and accepts input ───────
    def test_cmd_session_renders_and_accepts_input(self):
        self.close_all_tabs()
        name = unique_name("win-cmd")
        self.create_local_connection(name, shell="cmd")
        self.switch_to_connections_sidebar()
        self.connect_connection(name)

        self.wait(self.has_terminal, what="the cmd.exe shell to be readable")
        marker = "WIN_CMD_MARKER"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    # ── MT-LOCAL-13: the Local shell dropdown defaults to PowerShell ────────────
    def test_shell_dropdown_defaults_to_powershell(self):
        self.set_sidebar_visible(True)
        self.open_new_connection_editor()
        self.wait(lambda: self.driver.exists("field-shell"), what="the shell field")
        assert "powershell" in self.driver.get_value("field-shell").lower()
        self.driver.click(self.EDITOR_CANCEL)

    # ── MT-LOCAL-11: the Local dropdown offers the Windows shells; WSL is its
    #    own type ───────────────────────────────────────────────────────────────
    def test_shell_dropdown_offers_windows_shells_and_wsl_is_a_type(self):
        self.set_sidebar_visible(True)
        self.open_new_connection_editor()
        self.wait(lambda: self.driver.exists("field-shell"), what="the shell field")
        # Both Windows shells must be selectable options (select succeeds only if
        # the <option> exists), proving the dropdown is populated per-OS.
        self.select_shell("powershell")
        self.select_shell("cmd")
        # WSL is no longer a shell-dropdown entry — it is a first-class connection
        # type, so the type <select> must offer it on Windows.
        self.select_connection_type("wsl")
        assert self.driver.get_value(self.EDITOR_TYPE) == "wsl"
        self.driver.click(self.EDITOR_CANCEL)

    # ── MT-LOCAL-04: rapidly created shells each accept input independently ─────
    def test_rapidly_created_shells_accept_input(self):
        self.close_all_tabs()
        cases = [("win-rapid-ps", "powershell"), ("win-rapid-cmd", "cmd")]
        names = []
        for purpose, shell in cases:
            name = unique_name(purpose)
            self.create_local_connection(name, shell=shell)
            self.switch_to_connections_sidebar()
            self.connect_connection(name)
            names.append(name)

        assert self.tab_count() >= len(cases)
        for name in names:
            tab = self.wait(lambda n=name: self.find_tab(n), what=f"tab {name!r}")
            self.switch_to_tab(tab["id"])
            marker = f"RAPID_{name[-8:]}"
            self.run_command(f"echo {marker}")
            assert marker in self.wait_for_output(marker, tab_id=tab["id"])

    # ── MT-LOCAL-06: a Windows shell starts without excessive delay ─────────────
    def test_shell_starts_without_excessive_delay(self):
        self.close_all_tabs()
        name = unique_name("win-startup")
        self.create_local_connection(name, shell="powershell", connect=True)
        # A readable buffer means the shell process started and printed; the wait's
        # default timeout (well under the old 5 s budget) is the delay ceiling.
        self.wait(self.has_terminal, what="the shell to start promptly")

    # ── MT-LOCAL-16: the toolbar "new terminal" opens the default shell ─────────
    def test_new_terminal_toolbar_opens_default_shell(self):
        self.close_all_tabs()
        # ensure_terminal clicks the toolbar new-terminal button when none exists,
        # which is the same action as the Ctrl+Shift+` shortcut; it resolves only
        # once a shell has printed a prompt.
        self.ensure_terminal()
        assert self.has_terminal()

    # ── cwd: the local file browser follows a Windows shell's directory ─────────
    def test_file_browser_shows_path_for_a_windows_shell(self):
        self.close_all_tabs()
        name = unique_name("win-fb")
        self.create_local_connection(name, shell="powershell", connect=True)
        self.wait(self.has_terminal, what="the shell to be readable")
        path = self.open_file_browser()
        assert is_absolute_path(path)
        self.switch_to_connections_sidebar()


@skip_on_non_windows
@skip_without_wsl
class TestWsl(
    TerminalUi, TabsUi, LayoutUi, SidebarUi, FilesUi, ConnectionsUi, SystemTest
):
    """WSL sessions via the dedicated ``wsl`` type: spawn, cwd, path translation."""

    def _open_wsl_terminal(self, purpose: str) -> str:
        """Create + open a WSL terminal on the default distro and await its prompt.

        Returns the connection name. Uses **Save & Connect** — WSL has no auth
        step, so the session opens directly with no password prompt.
        """
        self.close_all_tabs()
        name = unique_name(purpose)
        self.create_wsl_connection(name, distribution=_WSL_DISTRO, connect=True)
        self.wait(self.has_terminal, what="the WSL shell to be readable")
        return name

    # ── MT-LOCAL-12: a WSL distro launches and accepts POSIX input ──────────────
    def test_wsl_session_renders_and_accepts_input(self):
        self._open_wsl_terminal("wsl-launch")
        marker = "WSL_MARKER"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    # ── MT-LOCAL-20: WSL startup has no "clear: command not found" error ────────
    def test_wsl_has_no_clear_command_error(self):
        self._open_wsl_terminal("wsl-clear")
        text = self.wait(
            lambda: (lambda t: t if t.strip() else None)(self.driver.read_terminal()),
            what="the WSL shell to print its prompt",
        )
        assert "clear: command not found" not in text

    # ── MT-LOCAL-17: the WSL file browser shows an absolute initial path ────────
    def test_wsl_file_browser_shows_initial_path(self):
        self._open_wsl_terminal("wsl-fb-init")
        path = self.open_file_browser()
        # WSL paths surface as a UNC share (\\wsl$\<distro>\... or \\wsl.localhost\)
        # or a drive mount; all are absolute.
        assert is_absolute_path(path)
        self.switch_to_connections_sidebar()

    # ── MT-LOCAL-18: the WSL file browser follows a `cd` in the shell ───────────
    def test_wsl_file_browser_follows_cd(self):
        self._open_wsl_terminal("wsl-fb-cd")
        self.open_file_browser()
        # The terminal stays active while the Files sidebar is shown, so input
        # reaches it; OSC 7 emits the new cwd on the next prompt and the browser
        # follows it.
        self.run_command("cd /tmp")
        path = self.wait_for_path_contains("tmp")
        assert "tmp" in path

    # ── MT-LOCAL-19: /mnt/<drive> shows the native Windows path ─────────────────
    def test_wsl_file_browser_translates_mnt_drive(self):
        self._open_wsl_terminal("wsl-fb-mnt")
        self.open_file_browser()
        # /mnt/c is a Windows drive mount; the browser shows it as a native drive
        # path (C:/...) rather than the inaccessible \\wsl$\ UNC view.
        self.run_command("cd /mnt/c")
        path = self.wait(
            lambda: (lambda p: p if re.search(r"[A-Za-z]:", p) else None)(
                self.file_browser_path()
            ),
            what="a Windows drive path in the file browser",
        )
        assert re.search(r"[Cc]:", path)
