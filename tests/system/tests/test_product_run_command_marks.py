"""Product run: terminal command marks are visible, hoverable and readable (#5854).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` found (R-078) that the success/failure marks shell
integration draws beside each finished command were 3px bars; the red failure
bar was dashed and at a normal viewing distance looked like the green one in a
different shade, so users with red-green colour weakness got almost no signal,
and nothing said which exit code a command returned.

Now the mark is 5px wide, its hover area covers the whole left padding and is
at least 24px tall, failure is a notched bar (success stays solid), both reach
3:1 on the terminal background in every built-in theme, and the mark's tooltip
and accessible name carry the exit code and the command's run time
("Command failed · exit code 1 · took 2.3s").

The live steps open a bash tab with command marks on, run ``false`` and
``true`` and read the rendered marks through ``measure_terminal``. The
``test_grade_*`` functions grade fixed measurements without an app and run in
the normal lane.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.colors import Rgba, contrast, parse_color
from termihub_harness.product_run import ProductRunUi
from termihub_harness.ui.theme import BUILTIN_THEMES, ThemeUi

#: WCAG 2.2 SC 1.4.11: a state indicator needs 3:1 on what it sits on.
UI_COMPONENT_MIN = 3.0
#: The visible bar: wide enough to see at a glance (R-078: 3px was not).
MIN_MARK_WIDTH = 4.5
#: WCAG 2.2 SC 2.5.8 asks 24px; the mark's hover area is at least that tall.
MIN_HIT_HEIGHT = 24.0
#: The hover area spans the inset, the bar and the gutter (>= 2 + 5 + 6 px).
MIN_HIT_WIDTH = 12.0
#: The gutter #5640 keeps between the bar and the prompt text.
MIN_GAP_TO_TEXT = 5.5

SUCCESS_CLASS = "terminal-command-mark--success"
FAILURE_CLASS = "terminal-command-mark--failure"
LABEL = re.compile(
    r"^Command (?P<outcome>succeeded|failed) · exit code (?P<code>-?\d+)(?: · took (?P<took>\S+))?$"
)


# ── grading ───────────────────────────────────────────────────────────────
def mark_problems(mark: dict[str, Any], expect_code: int) -> list[str]:
    """One rendered mark: size, hover reach, gutter, shape and tooltip."""
    failed = expect_code != 0
    kind = "failure" if failed else "success"
    problems = []
    if mark.get("width", 0) < MIN_MARK_WIDTH:
        problems.append(f"{kind} mark only {mark.get('width', 0):.1f}px wide")
    hit = mark.get("hitArea") or {}
    if hit.get("width", 0) < MIN_HIT_WIDTH or hit.get("height", 0) < MIN_HIT_HEIGHT:
        problems.append(
            f"{kind} mark hover area only {hit.get('width', 0):.1f}x{hit.get('height', 0):.1f}px"
        )
    gap = mark.get("gapToText")
    if gap is None or gap < MIN_GAP_TO_TEXT:
        problems.append(f"{kind} mark touches the text (gap {gap})")
    shaped = (mark.get("maskImage") or "none") != "none"
    if failed and not shaped:
        problems.append("failure mark has no shape of its own (colour only)")
    if not failed and shaped:
        problems.append("success mark is not a solid bar")
    match = LABEL.match(mark.get("title") or "")
    if not match:
        problems.append(f"{kind} mark tooltip does not name the exit code: {mark.get('title')!r}")
    else:
        if int(match["code"]) != expect_code:
            problems.append(f"{kind} mark tooltip says exit code {match['code']}, not {expect_code}")
        if (match["outcome"] == "failed") != failed:
            problems.append(f"{kind} mark tooltip says {match['outcome']}")
    return problems


def mark_contrast_problems(success: Rgba, error: Rgba, terminal_bg: Rgba) -> list[str]:
    """Both mark colours reach 3:1 on the terminal background."""
    return [
        f"{name} mark {fg.hex()} only {contrast(fg, terminal_bg):.2f}:1 on {terminal_bg.hex()}"
        for name, fg in (("success", success), ("failure", error))
        if contrast(fg, terminal_bg) < UI_COMPONENT_MIN
    ]


# ── app-free grade tests ──────────────────────────────────────────────────
def _mark(**overrides: Any) -> dict[str, Any]:
    base = {
        "classes": ["xterm-decoration", "terminal-command-mark", FAILURE_CLASS],
        "maskImage": "linear-gradient(black, black), linear-gradient(black, black)",
        "title": "Command failed · exit code 1 · took 12ms",
        "hitArea": {"width": 13.0, "height": 24.0},
        "gapToText": 6.0,
        "width": 5.0,
        "height": 17.0,
    }
    base.update(overrides)
    return base


def test_grade_a_good_failure_mark_passes():
    assert mark_problems(_mark(), 1) == []


def test_grade_a_good_success_mark_passes():
    ok = _mark(maskImage="none", title="Command succeeded · exit code 0")
    assert mark_problems(ok, 0) == []


def test_grade_the_old_thin_dashed_mark_fails():
    """The R-078 mark: 3px, hover area the bar itself, old tooltip wording."""
    old = _mark(
        width=3.0,
        hitArea={"width": 3.0, "height": 17.0},
        maskImage="repeating-linear-gradient(black 0px 4px, transparent 4px 6px)",
        title="Command failed (exit code 1)",
    )
    problems = mark_problems(old, 1)
    assert "failure mark only 3.0px wide" in problems
    assert "failure mark hover area only 3.0x17.0px" in problems
    assert any("tooltip does not name the exit code" in p for p in problems)


def test_grade_colour_only_failure_fails():
    assert mark_problems(_mark(maskImage="none"), 1) == [
        "failure mark has no shape of its own (colour only)"
    ]


def test_grade_wrong_exit_code_in_tooltip_fails():
    problems = mark_problems(_mark(title="Command failed · exit code 2"), 1)
    assert problems == ["failure mark tooltip says exit code 2, not 1"]


def test_grade_mark_touching_text_fails():
    assert mark_problems(_mark(gapToText=1.0), 1) == ["failure mark touches the text (gap 1.0)"]


def test_grade_mark_contrast():
    dark = parse_color("#1e1e1e")
    assert mark_contrast_problems(parse_color("#4ec9b0"), parse_color("#f48771"), dark) == []
    weak = mark_contrast_problems(parse_color("#4ec9b0"), parse_color("#5a2a2a"), dark)
    assert len(weak) == 1 and weak[0].startswith("failure mark #5a2a2a")


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's shell is POSIX-only")
class TestProductRunCommandMarks(
    ProductRunUi, ThemeUi, TerminalUi, TabsUi, SettingsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Command marks"
    request_timeout = 90.0

    _tab_id: Optional[str] = None

    def _finished_exit_codes(self, tab_id: str) -> list[Any]:
        marks = self.driver.inspect_terminal(tab_id).get("commandMarks") or {"commands": []}
        return [c["exitCode"] for c in marks["commands"] if c["state"] == "finished"]

    def _marks(self, tab_id: str, cls: str) -> list[dict[str, Any]]:
        decorations = self.driver.measure_terminal(tab_id)["decorations"]
        return [d for d in decorations if cls in d["classes"] and d["height"] > 0]

    def _send(self, tab_id: str, command: str) -> None:
        self.wait(
            lambda: self.driver.terminal_input(command, tab_id) is None,
            what=f"the shell to accept {command!r}",
        )

    def test_10_marks_are_visible_hoverable_and_labelled(self):
        with self.step(
            "terminal.command-marks.shape",
            "Failure and success marks are wide, differ in shape and name the exit code (#5854)",
            expect="a bash tab: a notched red bar by false and a solid green bar by true, "
            "both clearly visible beside the prompt",
        ):
            if not Path("/bin/bash").exists() and not Path("/usr/bin/bash").exists():
                pytest.skip("bash is not installed on this host")
            self.close_all_tabs()
            name = unique_name("marks-5854")
            self.switch_to_connections_sidebar()
            self.create_local_connection(name, shell="bash", command_marks=True, connect=True)
            tab_id = self.wait(lambda: self.find_tab(name), what="the bash tab")["id"]
            type(self)._tab_id = tab_id
            self.wait(
                lambda: (self.driver.inspect_terminal(tab_id).get("commandMarks") or {}).get(
                    "commands"
                ),
                what="bash's first marked prompt",
            )
            self._send(tab_id, "false")
            self.wait(lambda: self._finished_exit_codes(tab_id)[-1:] == [1], what="false done")
            self._send(tab_id, "true")
            self.wait(lambda: self._finished_exit_codes(tab_id)[-2:] == [1, 0], what="true done")
            bad, ok = self.wait(
                lambda: (
                    lambda f, s: (f[-1], s[-1]) if f and s else None
                )(self._marks(tab_id, FAILURE_CLASS), self._marks(tab_id, SUCCESS_CLASS)),
                what="a failure and a success mark",
            )
            self.evidence(f"failure mark: {bad}")
            self.evidence(f"success mark: {ok}")
            problems = mark_problems(bad, 1) + mark_problems(ok, 0)
            assert not problems, problems

    def test_20_marks_reach_3_to_1_in_every_theme(self):
        tab_id = type(self)._tab_id
        for theme in BUILTIN_THEMES:
            with self.step(
                f"terminal.command-marks.{theme}.contrast",
                f"{theme}: both command marks reach 3:1 on the terminal (#5854)",
                expect=f"the bash tab in {theme}; the red and green marks stand out "
                "from the terminal background",
            ):
                self.require("terminal.command-marks.shape")
                self.set_theme(theme)
                success = self.root_color("--color-success")
                error = self.root_color("--color-error")
                terminal_bg = self.root_color("--terminal-bg")
                if tab_id:
                    ok = self._marks(tab_id, SUCCESS_CLASS)
                    if ok:
                        # The bar paints the token itself, at full strength.
                        success = parse_color(ok[-1]["background"])
                self.evidence(
                    f"success {success.hex()} {contrast(success, terminal_bg):.2f}:1, failure "
                    f"{error.hex()} {contrast(error, terminal_bg):.2f}:1 on {terminal_bg.hex()}"
                )
                problems = mark_contrast_problems(success, error, terminal_bg)
                assert not problems, problems
