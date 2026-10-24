"""Colour and glyph grades on a native capture of the app window (#4937).

These replace guided visual checks where an operator looked at the terminal
and confirmed what it painted. The DOM ``screenshot`` cannot see the xterm
WebGL canvas, so each test captures the test app's own window through the OS
(located by the PID the harness launched — never by app name, see
:mod:`termihub_harness.window_capture`), maps the cell grid onto it with
``measure_terminal`` and checks the pixels of each cell against the colour
``read_terminal_cells`` says it should paint:

- MT-SSH-02 — the 16 ANSI colours (background fills and ``█`` foregrounds)
  and five 256-colour swatches paint their palette colour, the swatches
  with no gap between cells;
- MT-UI-31 — box-drawing strokes run unbroken across cell boundaries, both
  horizontally and vertically;
- MT-SER-01 / MT-SER-02 — Nerd Font / Powerline glyphs render from the bundled
  MesloLGS Nerd Font: each has ink and differs from the "missing glyph"
  rendering of an unassigned codepoint. The hosted runners have no Nerd
  Font installed, so on the Windows leg this is the clean-Windows check;
- MT-SSH-01 — an Agnoster prompt's ``user@host`` segment (ANSI black
  background) blends into the terminal background instead of painting a
  black rectangle. The bytes are the ones zsh + Agnoster send; the transport
  (local shell here, SSH in the field) does not change what xterm paints.

The payload is written to a home file and ``cat``-ed, so no escape sequence
is typed into the shell. Runs in the integration lane on every OS.
"""

from __future__ import annotations

import glob
import os
import sys
from typing import Any

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    ShellFsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.pixel_grades import (
    cell_fill,
    close,
    distance,
    dominant_color,
    glyph_mask,
    hex_rgb,
    horizontal_line,
    mask_distance,
    vertical_line,
)
from termihub_harness.ui.native_capture import NativeCaptureUi, TerminalCapture
from termihub_harness.ui.theme import ThemeUi
from termihub_harness.window_capture import Rect

pytestmark = pytest.mark.integration

ESC = "\x1b"
PAYLOAD = "th_capture_payload.txt"

#: The 8 normal + 8 bright ANSI background codes.
ANSI_BG = [*range(40, 48), *range(100, 108)]
#: The matching foreground codes.
ANSI_FG = [*range(30, 38), *range(90, 98)]
#: Five xterm 256-palette swatches and the colour each must paint.
SWATCHES = {196: "#ff0000", 46: "#00ff00", 21: "#0000ff", 226: "#ffff00", 201: "#ff00ff"}
#: Nerd Font glyphs: branch (Powerline), folder (Font Awesome), the Powerline arrow.
NERD_GLYPHS = {"branch": "\ue0a0", "folder": "\uf07c", "arrow": "\ue0b0"}
#: Unassigned codepoints no font has: how a missing glyph renders here.
MISSING = ("\U0010fffd", "\U0010fffc")


def _system_nerd_fonts() -> list[str]:
    """Nerd Font files installed system-wide or per-user on Windows (none on CI)."""
    if not sys.platform.startswith("win"):
        return []
    dirs = [
        os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts"),
    ]
    found: list[str] = []
    for d in dirs:
        for pattern in ("*Nerd*", "*NF-*", "MesloLGS*"):
            found.extend(glob.glob(os.path.join(d, pattern)))
    return found


class TestNativeCaptureGrades(
    NativeCaptureUi,
    ThemeUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    ShellFsUi,
    SystemTest,
):
    """Cell colours and glyph shapes, graded on the real painted pixels."""

    def reset_before_rerun(self) -> None:
        self.reset_tabs()

    @pytest.fixture(autouse=True)
    def _dark_theme_and_cleanup(self):
        # Unset means Dark (the default); selecting it again would write nothing.
        if self.current_theme() not in (None, "dark"):
            self.set_theme("dark")
        yield
        self.remove_home(PAYLOAD)

    # ── helpers ─────────────────────────────────────────────────────────────
    def _show(self, lines: list[str], last_marker: str) -> str:
        """Open a fresh POSIX shell, ``cat`` ``lines`` from a file; return the tab id."""
        self.close_all_tabs()
        name = unique_name("capture")
        self.switch_to_connections_sidebar()
        self.create_local_connection(name, shell=self.posix_shell_name(), connect=True)
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")["id"]
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the shell prompt")
        # Before the payload: switching renderer (macOS) refits and reflows the
        # buffer, which would move the rows read below.
        self.use_capturable_renderer(tab)
        body = "".join(f"{line}{ESC}[0m\n" for line in lines) + "TH_CAPTURE_DONE\n"
        self.write_home_bytes(PAYLOAD, body.encode("utf-8"))
        self.wait(
            lambda: self.driver.terminal_input(f"cat ~/{PAYLOAD}", tab) is None,
            what="the shell to accept the cat",
        )
        self.wait(
            lambda: self.driver.read_terminal_cells(last_marker, tab_id=tab),
            what=f"the {last_marker!r} row",
        )
        self.wait_for_output("TH_CAPTURE_DONE", tab_id=tab)
        return tab

    def _row(self, tab: str, marker: str) -> dict[str, Any]:
        rows = self.driver.read_terminal_cells(marker, tab_id=tab)
        assert len(rows) == 1, f"expected one {marker!r} row, got {len(rows)}"
        return rows[0]

    @staticmethod
    def _fill_grade(cap: TerminalCapture, row: dict[str, Any], cols: list[int], key: str):
        """Every cell in ``cols`` of ``row`` paints its model ``key`` colour."""
        rects, wrong = [], []
        for col in cols:
            cell = row["cells"][col]
            rect = cap.buffer_cell_rect(col, row["y"])
            rects.append(rect)
            want, got = hex_rgb(cell[key]), cell_fill(cap.frame, rect)
            if not close(want, got):
                wrong.append(f"col {col} {cell[key]} painted #{bytes(got).hex()}")
        return (not wrong), rects, "; ".join(wrong) or "ok"

    # ── MT-SSH-02 ───────────────────────────────────────────────────────────
    def test_ansi_16_colours_paint_their_palette_colour(self):
        """MT-SSH-02: ANSI backgrounds and ``█`` foregrounds paint the theme palette."""
        bg = "BG:" + "".join(f"{ESC}[{code}m  " for code in ANSI_BG)
        fg = "FG:" + "".join(f"{ESC}[{code}m\u2588\u2588" for code in ANSI_FG)
        bold = f"BOLD:{ESC}[1;37mBOLD"
        tab = self._show([bg, fg, bold], "BOLD:")
        bg_row, fg_row, bold_row = (self._row(tab, m) for m in ("BG:", "FG:", "BOLD:"))

        # The model resolves the eight normal colours to eight distinct theme colours.
        normal = {bg_row["cells"][3 + 2 * i]["bg"] for i in range(8)}
        assert len(normal) == 8, f"ANSI 40-47 resolved to {sorted(normal)}"
        assert all(c["bold"] for c in bold_row["cells"][5:9]), bold_row["cells"][5:9]

        cols = list(range(3, 3 + 2 * len(ANSI_BG)))
        self.wait_for_terminal_paint(
            lambda cap: self._fill_grade(cap, bg_row, cols, "bg"),
            what="every ANSI background to paint its colour",
            tab_id=tab,
        )
        self.wait_for_terminal_paint(
            lambda cap: self._fill_grade(cap, fg_row, cols, "fg"),
            what="every ANSI foreground block to paint its colour",
            tab_id=tab,
        )

    def test_256_colour_swatches_paint_without_gaps(self):
        """MT-SSH-02: five 256-colour swatches paint the xterm cube, edge to edge."""
        line = "256:" + "".join(f"{ESC}[48;5;{n}m  " for n in SWATCHES) + f"{ESC}[0m 256-OK"
        tab = self._show([line], "256-OK")
        row = self._row(tab, "256-OK")
        cols = list(range(4, 4 + 2 * len(SWATCHES)))
        assert [row["cells"][c]["bg"] for c in cols[::2]] == list(SWATCHES.values())

        def grade(cap: TerminalCapture):
            ok, rects, detail = self._fill_grade(cap, row, cols, "bg")
            if not ok:
                return ok, rects, detail
            strip = cap.buffer_cell_rect(cols[0], row["y"], len(cols))
            mid = Rect(strip.x, strip.y + strip.h // 2, strip.w, 1)
            gap = horizontal_line(cap.frame, mid, cap.background) is None
            return (not gap), [strip], "a background-coloured gap between swatches" if gap else ""

        self.wait_for_terminal_paint(grade, what="the 256-colour swatches", tab_id=tab)

    # ── MT-UI-31 ────────────────────────────────────────────────────────────
    def test_box_drawing_strokes_are_continuous(self):
        """MT-UI-31: box-drawing borders join across cells with no gaps."""
        inner = 6
        lines = [
            "BOX:\u250c" + "\u2500" * inner + "\u2510",
            "BOX:\u2502" + " " * inner + "\u2502",
            "BOX:\u2514" + "\u2500" * inner + "\u2518",
        ]
        tab = self._show(lines, "BOX:\u2514")
        rows = self.driver.read_terminal_cells("BOX:", tab_id=tab)
        assert [r["y"] - rows[0]["y"] for r in rows] == [0, 1, 2], rows
        top, left, right = rows[0]["y"], 4, 4 + inner + 1

        def grade(cap: TerminalCapture):
            cw, ch = cap.cell_size
            bg = cap.background
            a, b = cap.buffer_cell_rect(left, top), cap.buffer_cell_rect(right, top + 2)
            # From just inside the corners' centres, where their strokes start.
            cx0, cx1 = a.x + int(cw / 2) + 2, b.x + int(cw / 2) - 2
            cy0, cy1 = a.y + int(ch / 2) + 2, b.y + int(ch / 2) - 2
            strokes = {
                "top": Rect(cx0, a.y, cx1 - cx0, a.h),
                "bottom": Rect(cx0, b.y, cx1 - cx0, b.h),
                "left": Rect(a.x, cy0, a.w, cy1 - cy0),
                "right": Rect(b.x, cy0, b.w, cy1 - cy0),
            }
            broken = [
                name
                for name, rect in strokes.items()
                if (horizontal_line if name in ("top", "bottom") else vertical_line)(
                    cap.frame, rect, bg
                )
                is None
            ]
            return (not broken), list(strokes.values()), f"broken strokes: {broken}"

        self.wait_for_terminal_paint(grade, what="continuous box-drawing strokes", tab_id=tab)

    # ── MT-SER-01 / MT-SER-02 ───────────────────────────────────────────────
    def test_nerd_font_glyphs_render_from_the_bundled_font(self):
        """MT-SER-01 / MT-SER-02: Powerline and Nerd Font glyphs are real glyphs, not tofu.

        MT-SER-02 asks for a Windows machine with no Nerd Font installed; the
        hosted Windows runner is one (asserted below), so the glyphs can only
        come from the font the app bundles.
        """
        if os.environ.get("CI"):
            assert not _system_nerd_fonts(), f"runner has Nerd Fonts: {_system_nerd_fonts()}"
        glyphs = " ".join([*NERD_GLYPHS.values(), *MISSING])
        tab = self._show([f"NF: {glyphs} END"], "NF:")
        row = self._row(tab, "NF:")
        # One narrow cell each, separated by spaces: NF:␠g␠g␠g␠m␠m
        cols = {name: 4 + 2 * i for i, name in enumerate([*NERD_GLYPHS, "missing1", "missing2"])}
        for name, col in cols.items():
            assert row["cells"][col]["width"] == 1, (name, row["cells"][col])

        def grade(cap: TerminalCapture):
            bg = cap.background
            rects = {name: cap.buffer_cell_rect(col, row["y"]) for name, col in cols.items()}
            masks = {name: glyph_mask(cap.frame, rect, bg) for name, rect in rects.items()}
            area = max(1, masks["branch"].w * masks["branch"].h)
            problems = []
            if mask_distance(masks["missing1"], masks["missing2"]) > 0.08:
                problems.append("missing glyphs do not render uniformly; cannot grade")
            for name in NERD_GLYPHS:
                ink = masks[name].ink / area
                diff = mask_distance(masks[name], masks["missing1"])
                if ink < 0.04:
                    problems.append(f"{name}: no ink ({ink:.1%})")
                elif diff < 0.08:
                    problems.append(f"{name}: same shape as a missing glyph ({diff:.1%} differs)")
            if mask_distance(masks["branch"], masks["folder"]) < 0.08:
                problems.append("branch and folder render identically")
            return (not problems), list(rects.values()), "; ".join(problems)

        self.wait_for_terminal_paint(grade, what="the Nerd Font glyphs", tab_id=tab)

    # ── MT-SSH-01 ───────────────────────────────────────────────────────────
    def test_agnoster_prompt_has_no_black_rectangle(self):
        """MT-SSH-01: the Agnoster ``user@host`` segment blends with the background."""
        context = " user@host "
        prompt = (
            f"AG:{ESC}[40m{ESC}[39m{context}{ESC}[44m{ESC}[30m\ue0b0{ESC}[30m ~/src "
            f"{ESC}[49m{ESC}[34m\ue0b0{ESC}[39m AG-END"
        )
        tab = self._show([prompt], "AG-END")
        row = self._row(tab, "AG-END")
        ctx_cols = list(range(3, 3 + len(context)))
        blue_col = 3 + len(context) + 1  # the space before "~/src"
        tail_col = len(row["cells"]) + 2  # past the text: plain default background

        def grade(cap: TerminalCapture):
            bg = cap.background
            rects = [cap.buffer_cell_rect(c, row["y"]) for c in ctx_cols]
            blank = cap.buffer_cell_rect(tail_col, row["y"])
            blue = cap.buffer_cell_rect(blue_col, row["y"])
            problems = []
            want_blue = hex_rgb(row["cells"][blue_col]["bg"])
            if not close(dominant_color(cap.frame, blue), want_blue):
                problems.append("the blue segment did not paint (mapping off?)")
            surface = cell_fill(cap.frame, blank)
            if not close(surface, bg):
                problems.append(f"the plain background painted #{bytes(surface).hex()}")
            for col, rect in zip(ctx_cols, rects):
                # The letters cover a minority of the cell: its dominant colour is its fill.
                got = dominant_color(cap.frame, rect)
                if distance(got, surface) > 12:
                    problems.append(f"col {col} painted #{bytes(got).hex()} on #{bytes(surface).hex()}")
            return (not problems), [*rects, blank, blue], "; ".join(problems[:6])

        self.wait_for_terminal_paint(grade, what="the Agnoster context segment to blend", tab_id=tab)

