"""Guided-manual shell, SSH-X11 and network-tool checks (#913).

Ported from the retired ``tests/manual/{local-shell,ssh,network-tools}.yaml``.
Each item needs something CI cannot judge: paint timing on real Windows
(ConPTY / WebView2, WSL), real macOS key repeat, memory in the OS task
manager, real GPU contexts, a native X window on the operator's desktop, raw
ICMP for traceroute, or the readability of a canvas chart.

The harness opens the shells (twenty of them for MT-LOCAL-33), prepares the git
repo with many untracked files, creates the X11 SSH connection against the
``ssh-x11`` fixture, and starts the traceroute / ping / HTTP monitor. The
operator watches and judges.

Covered: MT-LOCAL-03/08/30/31/32/33, MT-SSH-01/50/51/52, MT-NET-16/21.

Run with ``./pytest.sh --manual -k guided_shells_and_tools -s``.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    SSH_X11_PORT,
    ConnectionsUi,
    ManualUi,
    NetworkToolsUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

NEW_TERMINAL = "terminal-view-new-terminal"


class TestGuidedShellsAndTools(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    SidebarUi,
    SettingsUi,
    PasswordPromptUi,
    NetworkToolsUi,
    ManualUi,
    SystemTest,
):
    """Harness opens the shell / tool; operator watches the paint or the OS side."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def reset_before_rerun(self) -> None:
        self.reset_tabs()

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _x11_ssh_session(self) -> str:
        """Save + connect an SSH connection to the ssh-x11 fixture (X11 on by default)."""
        self.close_all_tabs()
        name = unique_name("x11-real")
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        self.select_connection_type("ssh")
        self.wait(lambda: self.driver.exists("field-host"), what="the SSH fields")
        self.driver.type("field-host", SSH_HOST)
        self.driver.type("field-port", str(SSH_X11_PORT))
        self.driver.type("field-username", SSH_USERNAME)
        self.driver.select("field-authMethod", "password")
        # X11 forwarding defaults ON for SSH; clicking the toggle would turn it off.
        self.wait(lambda: self.driver.exists("field-enableX11Forwarding"), what="the X11 toggle")
        self.driver.click(self.EDITOR_SAVE)
        self.connect_connection(name)
        return name

    # ── MT-LOCAL-03/30/31: Windows shells ────────────────────────────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_wsl_tab_opens_without_banner_flash(self):
        """MT-LOCAL-03 (a WSL distribution installed)."""
        self.close_all_tabs()
        self.open_wsl_editor()
        self.manual_step(
            "Pick a distribution in the open WSL editor, click Save & Connect and watch the "
            "terminal as it opens.",
            "No welcome banner or setup commands flash; a clean prompt appears directly.",
        )

    @pytest.mark.manual(platforms=["windows"])
    def test_windows_cmd_output_paints_in_order(self):
        """MT-LOCAL-30 (git on PATH)."""
        repo = Path(tempfile.mkdtemp(prefix="thub-cmd-paint-"))
        try:
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            for i in range(400):
                (repo / f"untracked-{i:03d}.txt").write_text("x", encoding="utf-8")
            self.close_all_tabs()
            self.create_local_connection(
                unique_name("cmd-paint"), shell="cmd", starting_directory=str(repo), connect=True
            )
            self.wait(self.has_terminal, what="the cmd tab")
            self.manual_step(
                "Run `git status`, press Enter twice; repeat a few times. Then run `dir /s`.",
                "The file list is one block with the prompts after it; no resize is needed "
                "and output does not slow down.",
            )
        finally:
            shutil.rmtree(repo, ignore_errors=True)

    @pytest.mark.manual(platforms=["windows"])
    def test_guided_git_for_windows_install(self):
        """MT-LOCAL-31 (a Windows host without Git Bash or WSL)."""
        self.close_all_tabs()
        self.open_new_connection_editor()
        self.manual_step(
            "Pick 'Git Bash — set up…' as the shell. Click Open git-scm.com and close the "
            "browser; click Install in terminal and finish the winget install (accept UAC). "
            "Reopen the shell picker without restarting.",
            "The browser opened the Git download page; an 'Install Git for Windows' tab ran "
            "winget; Git Bash is now a normal row and the set-up entry is gone.",
        )

    # ── MT-LOCAL-08: macOS key repeat ────────────────────────────────────────
    @pytest.mark.manual(platforms=["macos"])
    def test_macos_key_repeat(self):
        """MT-LOCAL-08."""
        self.close_all_tabs()
        self.ensure_terminal()
        self.manual_step(
            "Click into the terminal and hold `k` for 3 seconds.",
            "kkkk… repeats continuously with no delay and no accent picker.",
        )

    # ── MT-LOCAL-32/33: output flood, twenty GPU tabs ────────────────────────
    def test_output_flood_stays_bounded_and_ctrl_c_stops_it(self):
        """MT-LOCAL-32."""
        self.close_all_tabs()
        self.ensure_terminal()
        flood = "while ($true) { 'y' }" if sys.platform == "win32" else "yes"
        self.run_command(flood)
        self.manual_step(
            f"`{flood}` is running. For 30 s watch termiHub (PID {self.app.pid}) in the OS "
            "task manager and click around the UI, then press Ctrl+C in the terminal.",
            "Memory stays roughly flat and the UI responds; output stops within about a "
            "second and the prompt returns.",
        )
        log = self.app.log_path.read_text(encoding="utf-8", errors="replace")
        assert "write data discarded" not in log

    def test_twenty_terminal_tabs_render_and_release_gpu(self):
        """MT-LOCAL-33."""
        self.close_all_tabs()
        self.ensure_terminal()
        for _ in range(19):
            self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() >= 20, timeout=120.0, what="twenty tabs")
        listing = "Get-ChildItem" if sys.platform == "win32" else "ls"
        for tab_id in self.tab_ids():
            self.switch_to_tab(tab_id)
            self.run_command(listing)
        self.manual_step(
            "Click through every tab, then split the view to show two side by side. Open "
            "the Log Viewer and filter for 'renderer'.",
            "Every tab shows sharp text promptly, none blank or garbled; switching logs "
            "'renderer webgl (visible)' / 'renderer dom (hidden)'; no 'webgl context lost'.",
        )

    # ── MT-SSH-01: Agnoster prompt ───────────────────────────────────────────
    def test_agnoster_prompt_has_no_black_rectangle(self):
        """MT-SSH-01 (a Linux host with zsh + the Agnoster theme)."""
        self.close_all_tabs()
        self.manual_step(
            "Connect an SSH session to a Linux host using zsh + Agnoster and look at the "
            "user@machine prompt segment.",
            "The segment blends with the terminal background; no black rectangle behind it.",
        )

    # ── MT-SSH-50/51/52: X11 on the real desktop ─────────────────────────────
    @pytest.mark.manual(platforms=["linux"])
    @pytest.mark.usefixtures("ssh_x11_fixtures")
    def test_x11_forwarding_on_real_linux_desktop(self):
        """MT-SSH-50."""
        self._x11_ssh_session()
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait(self.has_terminal, what="the X11 SSH terminal")
        self.manual_step(
            "Run `xeyes` in the SSH terminal. Then, on a Wayland-only session without "
            "XWayland, connect the same connection again.",
            "No prompt (the running X server is adopted) and the xeyes window appears; "
            "Wayland-only shows the XWayland install hint, not a generic error.",
        )

    @pytest.mark.manual(platforms=["macos"])
    @pytest.mark.usefixtures("ssh_x11_fixtures")
    def test_xquartz_install_and_x11_window_on_macos(self):
        """MT-SSH-51 (a Mac without XQuartz)."""
        self._x11_ssh_session()
        self.manual_step(
            "Follow the XQuartz-missing guidance: Install (with Homebrew) or Install "
            "Homebrew then Retry, approve the admin prompt, answer the password prompt "
            f"({SSH_PASSWORD}), connect again and run `xclock`.",
            "Nothing installs before the click; the installer runs in a visible tab; "
            "XQuartz starts; the xclock window appears.",
        )

    @pytest.mark.manual(platforms=["windows"])
    @pytest.mark.usefixtures("ssh_x11_fixtures")
    def test_vcxsrv_install_consent_and_x11_window_on_windows(self):
        """MT-SSH-52 (a clean Windows box without VcXsrv)."""
        name = self._x11_ssh_session()
        self.manual_step(
            "In Set up X server click Enable and accept the winget UAC prompt; answer the "
            f"password prompt ({SSH_PASSWORD}); run `xeyes`, then disconnect.",
            "The connect pauses for consent and nothing downloads before Enable; progress "
            "shows and the xeyes window appears; no vcxsrv.exe is left in Task Manager.",
        )
        self.close_all_tabs()
        self.connect_connection(name)
        self.manual_step(
            "The harness connected again with X11.",
            "It does not prompt for the X server again.",
        )

    # ── MT-NET-16/21: traceroute and latency charts ──────────────────────────
    def test_traceroute_hops_stream_in(self):
        """MT-NET-16 (raw ICMP: run as root/admin where the OS requires it)."""
        self.close_all_tabs()
        self.open_tool_panel("traceroute", "traceroute-panel")
        self.driver.type("traceroute-host", "8.8.8.8")
        self.driver.click("traceroute-run")
        self.manual_observe(
            "The harness started a traceroute to 8.8.8.8.",
            "Hop rows stream in, each with hop number, address and three RTT columns; it "
            "completes or ends with `* * *` rows.",
        )

    def test_latency_charts_are_readable(self):
        """MT-NET-21."""
        self.close_all_tabs()
        self.start_ping("8.8.8.8")
        self.manual_step(
            "Let several replies arrive, then hover the latency chart (pull the network "
            "cable briefly to get a dropped sample).",
            "Uniform stroke width; ms gridlines from 0 with '…ms' labels; x axis in elapsed "
            "seconds; hover shows the exact latency; drops show a dashed marker and a gap.",
        )
        self.stop_ping()
        self.start_http_monitor("https://example.com")
        self.manual_observe(
            "The harness started an HTTP monitor for https://example.com.",
            "Its Response Time chart has the same readable axes and hover read-out.",
        )
        self.stop_http_monitor()
