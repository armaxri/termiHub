"""xterm glyph layout of CJK, combining marks, RTL and emoji ZWJ in a real WebView (#3059).

Follow-up of I18N-016 (PR #3058), which proved Unicode text survives the
dispatcher and WebSocket bridge codepoint-exact. This suite proves what the
terminal does with it once it reaches xterm in the real app: a POSIX shell
prints each sample (from octal escapes, so the echoed command line never
contains the glyphs), and the ``read_terminal_cells`` bridge verb reads xterm's
buffer cell model — the grid the renderer paints from:

- CJK characters each take **one wide cell** (width 2) plus a spacer (width 0);
- combining marks are **attached to their base cell**, never a cell of their own;
- RTL text is stored in **logical order**, one narrow cell per letter (xterm has
  no bidi reordering);
- an emoji ZWJ sequence keeps **every joiner on its emoji** and every emoji wide
  (the app's Unicode 11 width tables have no grapheme clustering), so no
  codepoint is dropped or split onto a stray cell.

The live renderer must paint them too: the test switches to xterm's DOM renderer
(a real WebGL context loss, as ``test_terminal_render_paths.py`` does) and waits
for the painted rows to carry each sample, then saves a screenshot artifact
(``glyphs.png`` under the test's artifacts dir) for visual diffing — the DOM
rasterizer cannot capture the WebGL canvas, the DOM renderer it can.

With the experimental **Combine emoji** setting on (#4177) the terminal uses
``@xterm/addon-unicode-graphemes`` instead: a ZWJ family, a skin-tone modifier
and a flag pair each become **one double-width glyph**; the setting is flipped
through the Settings UI like a user does and restored afterwards.

The same cell model is pinned per PR against the real xterm under jsdom by
``src/testbridge/terminalCells.test.ts`` (setting off) and
``src/components/Terminal/unicodeWidth.real-xterm.test.ts`` (both). POSIX shell only (Git Bash on
Windows, skipped without it). Integration lane (nightly), not per-PR CI.
"""

from __future__ import annotations

from typing import Any, Optional

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.artifacts import save_manual_screenshot

pytestmark = pytest.mark.integration

ZWJ = "‍"
#: xterm waits ~3 s for a context restore before firing ``onContextLoss``.
CONTEXT_LOSS_TIMEOUT = 30.0

#: ``(marker, sample, expected [chars, width] cells after the marker)``.
SAMPLES: list[tuple[str, str, list[list[Any]]]] = [
    (
        "G3059CJK:",
        "日本語한",
        [["日", 2], ["", 0], ["本", 2], ["", 0], ["語", 2], ["", 0], ["한", 2], ["", 0]],
    ),
    (
        "G3059MRK:",
        "éǟx",
        [["é", 1], ["ǟ", 1], ["x", 1]],
    ),
    (
        "G3059RTL:",
        "שלום",
        [["ש", 1], ["ל", 1], ["ו", 1], ["ם", 1]],
    ),
    (
        "G3059ZWJ:",
        f"👨{ZWJ}👩{ZWJ}👧|",
        [[f"👨{ZWJ}", 2], ["", 0], [f"👩{ZWJ}", 2], ["", 0], ["👧", 2], ["", 0], ["|", 1]],
    ),
]


#: Samples whose layout the Combine emoji setting changes, laid out clustered.
CLUSTERED_SAMPLES: list[tuple[str, str, list[list[Any]]]] = [
    (
        "G4177ZWJ:",
        f"👨{ZWJ}👩{ZWJ}👧|",
        [[f"👨{ZWJ}👩{ZWJ}👧", 2], ["", 0], ["|", 1]],
    ),
    ("G4177SKN:", "👍🏽|", [["👍🏽", 2], ["", 0], ["|", 1]]),
    ("G4177FLG:", "🇩🇪|", [["🇩🇪", 2], ["", 0], ["|", 1]]),
]

COMBINE_EMOJI_TOGGLE = "settings-terminal-combine-emoji"


def octal_escaped(text: str) -> str:
    """``text`` as POSIX ``printf`` octal escapes of its UTF-8 bytes."""
    return "".join(f"\\{byte:03o}" for byte in text.encode("utf-8"))


class TestTerminalGlyphShaping(
    TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SettingsUi, SystemTest
):
    def _open_shell(self) -> str:
        """Open a fresh POSIX local shell and return its tab id."""
        self.close_all_tabs()
        shell = self.posix_shell_name()
        name = unique_name("glyph")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, shell=shell, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} terminal tab")
        tab_id = tab["id"]
        self.wait(lambda: self.driver.read_terminal(tab_id).strip(), what="the shell prompt")
        return tab_id

    def _print_samples(
        self, tab_id: str, samples: list[tuple[str, str, list[list[Any]]]] = SAMPLES
    ) -> None:
        """Print every sample on its own line and wait for the last to land."""
        lines = "".join(octal_escaped(marker + sample) + "\\n" for marker, sample, _ in samples)
        self.run_command(f"printf '{lines}'")
        last = samples[-1][0]
        self.wait(
            lambda: self.driver.read_terminal_cells(last, tab_id=tab_id),
            what=f"the {last!r} row in the terminal buffer",
        )

    def _row_cells(self, tab_id: str, marker: str) -> list[list[Any]]:
        """The ``[chars, width]`` cells after ``marker`` on its single output row."""
        rows = self.driver.read_terminal_cells(marker, tab_id=tab_id)
        assert len(rows) == 1, f"expected one {marker!r} row, got {rows!r}"
        return [[c["chars"], c["width"]] for c in rows[0]["cells"][len(marker) :]]

    def test_buffer_cells_hold_wide_combining_rtl_and_zwj_glyphs(self):
        """Each sample lands in xterm's cell model with the Unicode 11 layout."""
        tab_id = self._open_shell()
        self._print_samples(tab_id)
        for marker, _sample, expected in SAMPLES:
            assert self._row_cells(tab_id, marker) == expected, marker

    def _combine_emoji_on(self) -> bool:
        # Absent from the settings region until first set; the default is off.
        return self.projection_region_cache(SETTINGS_REGION).get("combineEmoji") is True

    def _set_combine_emoji(self, enabled: bool) -> None:
        """Flip the Combine emoji toggle in Settings like a user does."""
        if self._combine_emoji_on() == enabled:
            return
        self.open_settings_category("terminal")
        self.wait(
            lambda: self.driver.exists(COMBINE_EMOJI_TOGGLE), what="the Combine emoji toggle"
        )
        self.driver.click(COMBINE_EMOJI_TOGGLE)
        self.wait(
            lambda: self._combine_emoji_on() == enabled,
            what=f"Combine emoji to be {'on' if enabled else 'off'}",
        )

    def test_combine_emoji_setting_clusters_emoji_into_one_wide_glyph(self):
        """With Combine emoji on, ZWJ/skin-tone/flag sequences are one wide glyph (#4177)."""
        self._set_combine_emoji(True)
        try:
            tab_id = self._open_shell()
            self._print_samples(tab_id, CLUSTERED_SAMPLES)
            for marker, _sample, expected in CLUSTERED_SAMPLES:
                assert self._row_cells(tab_id, marker) == expected, marker
        finally:
            self._set_combine_emoji(False)

    def _dom_rows(self, tab_id: str) -> Optional[list[str]]:
        m = self.driver.measure_terminal(tab_id)
        return m.get("domRows") if m.get("renderer") == "dom" else None

    def _switch_to_dom_renderer(self, tab_id: str) -> None:
        """Make the DOM renderer live (lose the WebGL context when WebGL is on)."""
        m = self.driver.measure_terminal(tab_id)
        if m.get("renderer") == "webgl":
            assert self.driver.lose_terminal_webgl_context(tab_id) is True
        self.wait(
            lambda: self._dom_rows(tab_id) is not None,
            timeout=CONTEXT_LOSS_TIMEOUT,
            what="the DOM renderer to be live",
        )

    def test_renderer_paints_the_glyphs_and_a_screenshot_is_captured(self, request):
        """The painted rows carry every sample; the screen is saved for visual review."""
        tab_id = self._open_shell()
        self._switch_to_dom_renderer(tab_id)
        self._print_samples(tab_id)

        def painted(marker: str, sample: str) -> bool:
            # The DOM renderer pads cells with spaces; compare without whitespace.
            want = "".join((marker + sample).split())
            return any(want in "".join(row.split()) for row in self._dom_rows(tab_id) or [])

        for marker, sample, _ in SAMPLES:
            self.wait(
                lambda m=marker, s=sample: painted(m, s),
                what=f"the DOM renderer to paint {marker!r}",
            )
        shot = save_manual_screenshot(self.driver, request.node.nodeid, label="glyphs")
        assert shot is not None and shot.stat().st_size > 0, "no glyph screenshot was captured"
