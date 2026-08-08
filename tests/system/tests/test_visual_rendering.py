"""Guided-manual tests for visual / rendering verification (issues #915, #1003).

Pixel- and timing-level rendering the DOM/store bridge cannot assert: glyph
shaping, ANSI colour fidelity, box-drawing joins, theme colours, scrollbar
styling, startup/connect white-flashes, and OS-level chrome (the dock/taskbar
icon). Following the guided-manual contract (#914), the harness sets up the
**exact** state — opens a terminal, emits the precise escape sequences, switches
the theme, performs a cold relaunch, or drives the SSH connect — and then asks
the operator only to *look* and confirm. Each uses :meth:`manual_observe`, which
attaches a screenshot to the report via the bridge ``screenshot`` verb (#900) so
the visual evidence is captured.

Covered (#915): ANSI colours (MT-SSH-02), 256-colour (MT-SSH-02), box-drawing
(MT-UI-31), Nerd Font / Powerline glyphs (MT-SER-01/02), theme colours
(MT-UI-02..09), and vertical scrollbar appearance (MT-UI-35/36).

Added (#1003): no startup white-flash (MT-UI-01), no SSH connect / setup-command
flash (MT-LOCAL-05), no black bar at the bottom of the terminal (MT-UI-16), and
the OS-level app icon (MT-UI-19). These are timing- and OS-level checks that stay
operator-confirmed, but the harness still automates everything around them — the
cold relaunch, the SSH connect, opening the terminal, and showing the screen — so
the operator only has to *look*.

Marked ``manual`` + ``integration``, so they **skip** on CI / normal runs and
run only under ``./pytest.sh --manual -k visual -s`` with an operator. The SSH
connect-flash case additionally needs the Docker SSH containers (the
``ssh_fixtures`` session fixture, which skips gracefully when no container
runtime is available).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    ManualUi,
    PasswordPromptUi,
    SETTINGS_REGION,
    SettingsUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

# Literal glyphs interpolated into the printf command the harness sends to the
# shell; the operator confirms they render. Powerline separators (U+E0B0/B2) +
# a Nerd Font branch glyph (U+E0A0) for MT-SER; the box uses the U+2500
# box-drawing range, with the newline left escaped for printf to expand.
_POWERLINE = "  "
_BOX = "┌───┐\\n│ hi │\\n└───┘"


class TestVisualRendering(
    TerminalUi,
    TabsUi,
    SettingsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    ManualUi,
    SystemTest,
):
    """Visual checks: harness emits the exact pixels, operator confirms them."""

    # ── ANSI colours (MT-SSH-02) ─────────────────────────────────────────────
    def test_ansi_colours_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(
            "printf '\\033[31mRED \\033[32mGREEN \\033[33mYELLOW "
            "\\033[34mBLUE \\033[35mMAGENTA \\033[36mCYAN \\033[1;37mBOLD\\033[0m\\n'"
        )
        self.wait_for_output("BOLD")
        self.manual_observe(
            "Look at the colour words on the output line.",
            "Each word is shown in its own colour (RED red, GREEN green, ...) and "
            "BOLD is bright/bold -- no mojibake or wrong colours.",
            label="ansi-colours",
        )

    # ── 256-colour (MT-SSH-02) ───────────────────────────────────────────────
    def test_256_colour_swatches_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(
            "printf '\\033[48;5;196m  \\033[48;5;46m  \\033[48;5;21m  "
            "\\033[48;5;226m  \\033[48;5;201m  \\033[0m 256-OK\\n'"
        )
        self.wait_for_output("256-OK")
        self.manual_observe(
            "Look at the row of coloured blocks before '256-OK'.",
            "Five distinct solid blocks (red, green, blue, yellow, magenta) -- "
            "proving 256-colour support, with no gaps between them.",
            label="ansi-256",
        )

    # ── Box-drawing characters (MT-UI-31) ────────────────────────────────────
    def test_box_drawing_characters_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        # A bordered box; the corners/edges must join into solid lines.
        self.run_command(f"printf '{_BOX}\\n'")
        self.wait_for_output("hi")
        self.manual_observe(
            "Look at the drawn box around 'hi'.",
            "The borders are continuous solid lines that meet cleanly at the "
            "corners -- no gaps, no broken segments between cells.",
            label="box-drawing",
        )

    # ── Nerd Font / Powerline glyphs (MT-SER-01/02) ──────────────────────────
    def test_powerline_glyphs_render(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.run_command(f"printf 'PL {_POWERLINE} END\\n'")
        self.wait_for_output("END")
        self.manual_observe(
            "Look at the glyphs between 'PL' and 'END'.",
            "If a Nerd Font / Powerline font is configured, they render as the "
            "arrow/branch glyphs (not empty boxes or 'tofu'). Note the configured "
            "font if they don't.",
            label="powerline-glyphs",
        )

    # ── Theme colours (MT-UI-02..09) ─────────────────────────────────────────
    def test_light_theme_applies(self):
        self.close_all_tabs()
        self.ensure_terminal()
        self.open_settings_category("appearance")
        self.driver.select("appearance-theme-select", "light")
        self.wait(
            lambda: self.projection_region_cache(SETTINGS_REGION).get("theme") == "light",
            what="the light theme to apply",
        )
        try:
            self.manual_observe(
                "Look at the whole app window (sidebar, tabs, panels, status bar).",
                "Everything switched to the light theme -- light backgrounds with "
                "dark, readable text across all chrome, no leftover dark patches.",
                label="theme-light",
            )
        finally:
            # Restore the default so later suites start from a known theme.
            self.driver.select("appearance-theme-select", "dark")
            self.wait(
                lambda: self.projection_region_cache(SETTINGS_REGION).get("theme") == "dark",
                what="the theme to restore to dark",
            )

    # ── Vertical scrollbar appearance (MT-UI-35/36) ──────────────────────────
    def test_vertical_scrollbar_appearance(self):
        self.close_all_tabs()
        self.ensure_terminal()
        # Fill well past one screen so a scrollbar is warranted, then scroll up.
        self.run_command('for i in $(seq 1 200); do echo "scrollback line $i"; done')
        self.wait_for_output("scrollback line 200")
        self.driver.scroll_terminal(-80)
        self.manual_observe(
            "Move the mouse over the terminal and look at its right edge while "
            "scrolled up into history; then move the mouse away.",
            "The vertical scrollbar is a thin, subtle themed bar that fades in "
            "on hover and fades out when the mouse leaves (auto-hide, VS Code "
            "style) -- no always-on bright bar, no jarring default-OS scrollbar. "
            "Its style matches the tab-bar/list scrollbars elsewhere in the app.",
            label="scrollbar",
        )
        self.driver.scroll_terminal(to_bottom=True)

    # ── No startup white-flash (MT-UI-01) ────────────────────────────────────
    def test_no_startup_white_flash(self):
        """Cold-relaunch the app; the operator watches the window background.

        The white-flash is a paint-timing artefact between the OS window
        appearing and the web view's first paint — invisible to the DOM/store
        bridge, so it stays operator-confirmed. The harness still automates the
        only setup that matters: a real kill-and-relaunch via ``restart_app``,
        so the operator just has to watch the window come up. They should keep
        their eyes on the window *before* triggering the prompt response, as the
        relaunch already happened — re-run the case if they missed it.
        """
        self.close_all_tabs()
        # A genuine cold start: kill the app and bring it back up. This is the
        # exact event MT-UI-01 checks; everything the operator needs is now on
        # screen, so they only have to recall what they just saw.
        self.restart_app()
        self.manual_observe(
            "Recall the window you just watched relaunch (re-run if you looked "
            "away — the app was killed and relaunched a moment ago).",
            "The window came up with the dark background (#1e1e1e) already "
            "painted -- no white flash between the OS window appearing and the "
            "app's first paint.",
            label="startup-no-white-flash",
        )

    # ── No SSH connect / setup-command flash (MT-LOCAL-05) ───────────────────
    @pytest.mark.usefixtures("ssh_fixtures")
    def test_no_ssh_connect_setup_flash(self):
        """Drive the password-SSH connect; the operator watches for a flash.

        Whether setup/wrapper commands briefly flash before the remote prompt is
        a timing artefact of the connect handshake the bridge cannot assert, so
        it stays operator-confirmed. The harness automates the whole connect —
        create the connection, Save & Connect, answer the password prompt, land
        in the terminal — so the operator only has to watch the terminal open.
        Needs the Docker SSH password container (``ssh_fixtures``); skips when no
        container runtime is available.
        """
        self.close_all_tabs()
        # Full automated connect (create + Save & Connect + password + terminal).
        # The operator should watch the terminal area while this runs.
        self.connect_ssh_password(unique_name("ssh-flash"))
        self.manual_observe(
            "Watch the terminal you just connected to as it opened (re-run if "
            "you looked away -- the SSH session was just established).",
            "The remote shell prompt appeared cleanly -- no flash of setup / "
            "wrapper commands before the prompt, no white/black flicker as the "
            "session opened.",
            label="ssh-connect-no-flash",
        )

    # ── No black bar at the bottom of the terminal (MT-UI-16) ────────────────
    def test_no_black_bar_at_terminal_bottom(self):
        """Open a terminal with a prompt; the operator checks the bottom edge.

        A stray black bar at the bottom of the terminal is a layout/sizing
        artefact (the xterm rows not filling the pane) the bridge cannot measure
        reliably, so it stays operator-confirmed. The harness automates standing
        up the terminal and getting a prompt on screen.
        """
        self.close_all_tabs()
        self.ensure_terminal()
        # Make the bottom rows clearly the prompt, not blank padding.
        self.run_command("echo bottom-bar-check")
        self.wait_for_output("bottom-bar-check")
        self.manual_observe(
            "Look at the very bottom edge of the terminal pane, below the last "
            "line of output.",
            "The terminal background fills all the way to the bottom of the pane "
            "-- no black bar / empty strip between the last row and the pane "
            "edge or status bar.",
            label="terminal-no-black-bar",
        )

    # ── OS-level app icon (MT-UI-19) ─────────────────────────────────────────
    def test_app_icon_in_dock_or_taskbar(self):
        """The operator checks the OS dock/taskbar/launcher icon.

        The app icon lives entirely in OS chrome outside the web view, so there
        is nothing the bridge can set up or assert — it is purely operator-
        confirmed. The harness only ensures the app is running and focused (a
        terminal exists) so the icon is present in the dock/taskbar to inspect.
        """
        self.ensure_terminal()
        self.manual_observe(
            "Check the app icon in the dock (macOS), taskbar (Windows), or "
            "launcher/dock (Linux) for the running app.",
            "The custom termiHub icon is displayed -- not a generic / default "
            "application icon.",
            label="app-icon",
        )
