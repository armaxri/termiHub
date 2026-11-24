"""Product run: the tab dot waits for the shell's first prompt (#5891).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` (surface ``zsh``, ``shots/checklist.zsh.question.png``)
found that a tab showed the green "connected" dot while its shell was still
blocked on a startup question, so nothing told the user that the session
waited for input rather than sitting at a ready prompt.

Now a tab whose connection turns shell integration (command marks) on shows a
neutral dashed dot, named "Waiting for the shell's first prompt", until the
shell's first OSC 133 mark arrives; then it shows the connected dot. A tab
without shell integration never gets a mark and keeps the connected dot.

The live steps seed a zsh connection whose ``.zshrc`` asks a one-key question
before the first prompt (scratch ``HOME`` / ``ZDOTDIR`` / ``HISTFILE``, never
the user's own), read the dot while the question waits, answer ``y`` and read
it again once the prompt is up. :func:`tab_dot_problems` grades the readings;
the ``test_grade_*`` functions run without an app in the normal lane.
"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional

import pytest

from termihub_harness import ConnectionsUi, SidebarUi, SystemTest, TabsUi, TerminalUi
from termihub_harness.product_run import ProductRunUi
from termihub_harness.store_versions import current_store_version

QUESTION_CONN = "Tab dot question (zsh)"
QUESTION = "Continue startup? Press y or n:"
PROMPT_TEXT = "dot-shell"
DOT_PREFIX = "tab-state-dot-"

#: The dot's state class and accessible name in each phase.
WAITING = ("tab__state-dot--starting", "Waiting for the shell's first prompt")
READY = ("tab__state-dot--connected", "Connected")
#: Classes that must never show while the shell waits for its first prompt.
NOT_WHILE_WAITING = ("tab__state-dot--connected", "tab__state-dot--failed")

_QUESTION_ZSHRC = f"""HISTFILE="$ZDOTDIR/.zsh_history"
if read -q "?{QUESTION} "; then echo; echo "ANSWER-Y"; else echo; echo "ANSWER-N"; fi
PROMPT='{PROMPT_TEXT} %# '
"""


# ── grading ───────────────────────────────────────────────────────────────
def tab_dot_problems(reading: Optional[dict[str, Any]], phase: str) -> list[str]:
    """What is wrong with a tab's status dot in ``phase``, or ``[]``.

    ``phase`` is ``"waiting"`` (the shell has not reached its first prompt)
    or ``"ready"`` (the prompt is up). ``reading`` holds the dot's ``class``,
    ``aria-label`` and ``title``; ``None`` means no dot was rendered.
    """
    if reading is None:
        return [f"no status dot while {phase}"]
    want_class, want_label = WAITING if phase == "waiting" else READY
    classes = (reading.get("class") or "").split()
    problems: list[str] = []
    if want_class not in classes:
        problems.append(f"dot while {phase} has classes {classes}, want {want_class}")
    if phase == "waiting":
        shown = [c for c in NOT_WHILE_WAITING if c in classes]
        if shown:
            problems.append(f"dot reads {shown[0]} before the shell's first prompt")
    for attr in ("aria-label", "title"):
        if reading.get(attr) != want_label:
            got = reading.get(attr)
            problems.append(f"dot {attr} while {phase} is {got!r}, want {want_label!r}")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
def _dot(state: str, label: str) -> dict[str, Any]:
    return {"class": f"tab__state-dot tab__state-dot--{state}", "aria-label": label, "title": label}


def test_grade_neutral_dot_while_waiting_passes():
    assert tab_dot_problems(_dot("starting", WAITING[1]), "waiting") == []


def test_grade_connected_dot_once_ready_passes():
    assert tab_dot_problems(_dot("connected", "Connected"), "ready") == []


def test_grade_the_old_green_dot_at_the_question_fails():
    """The R-171 reading: green 'Connected' while the startup question waits."""
    problems = tab_dot_problems(_dot("connected", "Connected"), "waiting")
    assert "dot reads tab__state-dot--connected before the shell's first prompt" in problems
    assert any(p.startswith("dot aria-label while waiting is 'Connected'") for p in problems)
    assert any(p.startswith("dot title while waiting") for p in problems)


def test_grade_dot_stuck_neutral_after_the_prompt_fails():
    problems = tab_dot_problems(_dot("starting", WAITING[1]), "ready")
    assert problems[0].startswith("dot while ready has classes")
    assert len(problems) == 3


def test_grade_missing_dot_fails():
    assert tab_dot_problems(None, "waiting") == ["no status dot while waiting"]


def test_grade_question_zshrc_isolates_history():
    """The seeded shell writes history only under its scratch ZDOTDIR."""
    assert _QUESTION_ZSHRC.startswith('HISTFILE="$ZDOTDIR/')
    assert QUESTION in _QUESTION_ZSHRC


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the question shell is zsh")
class TestProductRunTabStatusDot(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Tab status dot"
    request_timeout = 90.0

    _tab_id: Optional[str] = None

    def _seed_profile(self) -> None:
        zdotdir = self.profile_home.parent / "zsh-dot-question"
        zdotdir.mkdir(parents=True, exist_ok=True)
        (zdotdir / ".zshrc").write_text(_QUESTION_ZSHRC, encoding="utf-8")
        env = [
            {"key": "HOME", "value": str(self.profile_home)},
            {"key": "ZDOTDIR", "value": str(zdotdir)},
            {"key": "HISTFILE", "value": str(zdotdir / ".zsh_history")},
            {"key": "SHELL_SESSION_HISTORY", "value": "0"},
        ]
        doc = {
            "version": str(current_store_version("connections.json")),
            "agents": [],
            "children": [
                {
                    "type": "connection",
                    "name": QUESTION_CONN,
                    "config": {
                        "type": "local",
                        "config": {"shell": "zsh", "shellIntegration": True, "envVars": env},
                    },
                }
            ],
        }
        (self.config_dir / "connections.json").write_text(
            json.dumps(doc, indent=2) + "\n", encoding="utf-8"
        )

    def _dot(self, tab_id: str) -> Optional[dict[str, Any]]:
        testid = f"{DOT_PREFIX}{tab_id}"
        if not self.driver.exists(testid):
            return None
        attrs = ("class", "aria-label", "title")
        return {attr: self.driver.get_attribute(testid, attr) for attr in attrs}

    def test_10_dot_is_neutral_at_the_startup_question(self):
        with self.step(
            "tab-dot.waiting",
            "The tab dot stays neutral while zsh waits at its startup question (#5891)",
            expect="a zsh tab ending in 'Continue startup? Press y or n:' with a grey dashed "
            "ring, not a green dot, beside its name",
        ):
            self.restart_app(self._seed_profile)
            self.switch_to_connections_sidebar()
            self.wait(lambda: self.find_connection(QUESTION_CONN), what="the seeded connection")
            self.connect_connection(QUESTION_CONN)
            tab_id = self.wait(lambda: self.find_tab(QUESTION_CONN), what="the question tab")["id"]
            type(self)._tab_id = tab_id
            self.wait(lambda: QUESTION in self.driver.read_terminal(tab_id), what="the question")
            reading = self.wait(
                lambda: (lambda d: d if d and "--connecting" not in (d["class"] or "") else None)(
                    self._dot(tab_id)
                ),
                what="the dot to settle after connecting",
            )
            self.evidence(f"dot at the question: {reading}")
            problems = tab_dot_problems(reading, "waiting")
            assert not problems, problems

    def test_20_dot_turns_connected_at_the_first_prompt(self):
        tab_id = type(self)._tab_id
        with self.step(
            "tab-dot.ready",
            "After y the first prompt turns the tab dot connected (#5891)",
            expect="ANSWER-Y and the 'dot-shell %' prompt, with the green connected dot",
        ):
            self.require("tab-dot.waiting")
            assert tab_id
            self.driver.compose(["y"], "y", tab_id=tab_id)
            self.wait(lambda: PROMPT_TEXT in self.driver.read_terminal(tab_id), what="the prompt")
            reading = self.wait(
                lambda: (lambda d: d if d and READY[0] in (d["class"] or "") else None)(
                    self._dot(tab_id)
                ),
                what="the connected dot",
                timeout=15.0,
            )
            self.evidence(f"dot at the prompt: {reading}")
            problems = tab_dot_problems(reading, "ready")
            assert not problems, problems
