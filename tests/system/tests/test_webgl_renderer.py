"""Terminal WebGL renderer with DOM fallback (#2078).

The WebGL renderer (``@xterm/addon-webgl``) is the GPU-accelerated path for
xterm; it degrades to the DOM renderer whenever the WebView cannot create a
WebGL2 context or the context is lost at runtime. A renderer regression is
app-breaking (blank/garbled terminal), so this exercises the real WebView build:
it reads back which renderer went live (surfaced on the terminal container as
``data-terminal-renderer``) and proves the terminal still renders command output
through whichever renderer is active.

Runs in the integration lane (real built app), not per-PR CI — the point is to
verify the actual WebView, which unit tests (jsdom has no WebGL) cannot.
"""

import pytest

from termihub_harness import (
    ConnectionsUi,
    LayoutUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration


class TestWebglRenderer(TerminalUi, TabsUi, LayoutUi, SidebarUi, ConnectionsUi, SystemTest):
    def _connect_shell(self) -> str:
        """Open a local shell and return its active tab id."""
        self.close_all_tabs()
        name = unique_name("webgl")
        self.create_local_connection(name)
        self.switch_to_connections_sidebar()
        self.connect_connection(name)
        self.wait(lambda: self.find_tab(name), what=f"the {name!r} terminal tab")
        self.wait(self.has_terminal, what="the shell to be readable")
        active = self.active_tab()
        assert active is not None and active.get("id")
        return active["id"]

    def test_a_renderer_is_reported(self):
        """The container advertises the live renderer as webgl or dom (never blank)."""
        tab_id = self._connect_shell()
        renderer = self.driver.get_attribute(
            f"terminal-renderer-{tab_id}", "data-terminal-renderer"
        )
        # Either outcome is valid — WebGL when the WebView provides a WebGL2
        # context, dom when it falls back — but it must be one of them, proving
        # the renderer initialized deterministically rather than leaving a blank
        # terminal.
        assert renderer in ("webgl", "dom"), f"unexpected renderer: {renderer!r}"

    def test_terminal_renders_output_under_active_renderer(self):
        """Command output is rendered (buffer readable) through the live renderer."""
        self._connect_shell()
        marker = "WEBGL_RENDER_OK"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def test_output_survives_a_resize(self):
        """Resizing the window keeps the terminal rendering (reflow, no blank pane)."""
        self._connect_shell()
        marker = "RESIZE_RENDER_OK"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)
        # A resize reflows/re-fits the terminal; content must remain readable.
        self.driver.resize_window(1100, 800)
        self.driver.resize_window(1280, 900)
        assert marker in self.wait_for_output(marker)
