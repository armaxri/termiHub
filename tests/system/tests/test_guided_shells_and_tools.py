"""Guided-manual shell, SSH-X11 and network-tool checks (#913).

Ported from the retired ``tests/manual/{local-shell,ssh,network-tools}.yaml``.
Each item needs something CI cannot judge: a real WSL distribution, a real
Git-for-Windows install, a native X window on the
operator's desktop, raw ICMP for traceroute, or the readability of a canvas
chart.

The harness opens the shells, creates the X11 SSH connection against the
``ssh-x11`` fixture, and starts the traceroute / ping / HTTP monitor. The
operator watches and judges.

Covered: MT-LOCAL-03/31, MT-SSH-01/50/51/52, MT-NET-16/21. MT-LOCAL-30/32/33
are automated since #4931 (``test_windows_shells.py``,
``test_output_flash_and_flood.py``, ``test_performance.py``), MT-LOCAL-08 (macOS
key repeat) since #4935 (``test_os_input_keyboard.py``).

Run with ``./pytest.sh --manual -k guided_shells_and_tools -s``.
"""

from __future__ import annotations

import re

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
from termihub_harness.ui.theme import ThemeUi, near

pytestmark = [pytest.mark.integration, pytest.mark.manual]


class TestGuidedShellsAndTools(
    ThemeUi,
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

    # ── MT-LOCAL-03/31: Windows shells ───────────────────────────────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_wsl_tab_opens_without_banner_flash(self):
        """MT-LOCAL-03 (a WSL distribution installed).

        Stays guided: no CI lane runs the desktop app against a real WSL
        distribution. The SSH and local-shell variants of this flash grade are
        automated in ``test_output_flash_and_flood.py`` (#4931); an operator can
        confirm a WSL tab the same way with ``driver.read_terminal_output`` and
        ``termihub_harness.output_stream.find_flashes``.
        """
        self.close_all_tabs()
        self.open_wsl_editor()
        self.manual_step(
            "Pick a distribution in the open WSL editor, click Save & Connect and watch the "
            "terminal as it opens.",
            "No welcome banner or setup commands flash; a clean prompt appears directly.",
        )

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
        # The forwarded window itself is graded on Xvfb by test_ssh.py (MT-XPLAT-03,
        # #4932); the real desktop keeps the adopt-the-X-server and Wayland checks.
        self.manual_step(
            "Run `xeyes` in the SSH terminal. Then, on a Wayland-only session without "
            "XWayland, connect the same connection again.",
            "No prompt (your running X server is adopted); Wayland-only shows the "
            "XWayland install hint, not a generic error.",
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
        """MT-NET-21.

        The machine checks the chart first (#4930): the canvas paints the trace in
        the accent colour and the legend reads the latest sample in ms. The
        operator keeps only the readability glance.
        """
        self.close_all_tabs()
        self.start_ping("8.8.8.8")
        self.wait(lambda: self.driver.exists("latency-chart-canvas"), what="the latency chart")
        accent = self.root_color("--accent-color")
        self.wait(
            lambda: near(self.canvas_pixels("latency-chart-canvas"), accent) > 0,
            what="the chart to draw its latency trace",
        )
        self.wait(
            lambda: re.search(r"\dms", self.driver.get_text("ping-chart") or ""),
            what="the legend to read the latest sample in ms",
        )
        self.manual_step(
            "The harness confirmed the trace and the ms read-out. Hover the latency chart "
            "(pull the network cable briefly to get a dropped sample).",
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
