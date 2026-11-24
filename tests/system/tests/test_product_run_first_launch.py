"""Product run: the first launch (#5856).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review of run ``20261123T215628Z`` found that:

- R-086: the crash notice's "Don't show again" and "Close" were plain buttons
  of equal weight, "Don't show again" sat first where the eye lands and did
  not say its scope (this notice, or every future one?).
- R-087 / R-107: after the notice closed, the empty window offered a generic
  "Open connection…" (and a third "New connection" entry point) although the
  sidebar already listed the saved connections.
- R-085: after a wipe the app came back empty with no hint that a restore is
  possible from here.

Now the crash notice reads View report · **Close** (Close the one outlined
main action, on the right) with a small "Don't tell me about future crashes"
link under its text; with saved connections the empty window lists them,
most recently opened first, as one-click buttons; a profile without
connections offers New connection and Restore from backup….

The live steps read the screens; :func:`crash_notice_problems` and
:func:`empty_window_problems` grade the readings and run without an app in the
normal lane (bottom of this file).
"""

from __future__ import annotations

import json
import time
from typing import Any, Optional

import pytest

from termihub_harness import CrashReportUi, SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.store_versions import current_store_version
from termihub_harness.ui.diagnostics import (
    CRASH_NOTICE,
    CRASH_NOTICE_DISMISS,
    CRASH_NOTICE_NEVER,
    CRASH_NOTICE_VIEW,
    crash_report_name,
)

#: The opt-out link's wording: it names its real scope (R-086).
OPT_OUT_LABEL = "Don't tell me about future crashes"
#: The action row, left to right; the last one is the outlined main action.
CRASH_ACTIONS = ("View report", "Close")
CRASH_MAIN = "Close"

EMPTY = "empty-window-state"
EMPTY_NEW_TERMINAL = "empty-window-new-terminal"
EMPTY_NEW_CONNECTION = "empty-window-new-connection"
EMPTY_RESTORE = "empty-window-restore"
EMPTY_RECENT = "empty-window-recent"
EMPTY_RECENT_PREFIX = "empty-window-recent-"
#: The generic picker button the recent list replaced (R-087).
OLD_OPEN_CONNECTION_LABEL = "Open connection…"
RESTORE_TITLE = "backup-restore-title"
#: Most one-click connections the empty window offers.
RECENT_LIMIT = 5

FIRST_CONN = "First launch shell A"
SECOND_CONN = "First launch shell B"


# ── Grades (pure; unit-tested below) ─────────────────────────────────────────
def crash_notice_problems(m: dict[str, Any]) -> list[str]:
    """What is wrong with the crash notice's actions, or ``[]`` (R-086).

    ``m`` holds ``actions`` (the action row, left to right: ``text`` and
    ``class``) and ``link`` (``text``, ``class``, ``in_actions``: whether it
    sits inside the action row), or ``None`` when no link was found.
    """
    problems: list[str] = []
    actions = m.get("actions") or []
    texts = [a.get("text", "") for a in actions]
    if tuple(texts) != CRASH_ACTIONS:
        problems.append(f"crash notice actions read {texts}, want {list(CRASH_ACTIONS)}")
    mains = [a.get("text") for a in actions if "ui-btn--secondary" in a.get("class", "").split()]
    if mains != [CRASH_MAIN]:
        problems.append(f"the outlined main action is {mains}, want [{CRASH_MAIN!r}]")
    if any("ui-btn--primary" in a.get("class", "").split() for a in actions):
        problems.append("the crash notice has a filled primary (#5549)")
    if any(t.lower().startswith("don't show") for t in texts):
        problems.append("'Don't show again' is still a button in the action row")
    link = m.get("link")
    if not link:
        problems.append("the crash notice has no opt-out link")
    else:
        if link.get("text") != OPT_OUT_LABEL:
            problems.append(f"the opt-out reads {link.get('text')!r}, want {OPT_OUT_LABEL!r}")
        if link.get("in_actions"):
            problems.append("the opt-out link sits in the action row")
        if "ui-btn" in (link.get("class") or "").split():
            problems.append("the opt-out is a button, not a small link")
    return problems


def empty_window_problems(m: dict[str, Any]) -> list[str]:
    """What is wrong with the empty window, or ``[]`` (R-085, R-087, R-107).

    ``m`` holds ``saved`` (names of the saved connections), ``buttons`` (the
    visible button labels, in order), ``recent`` (the one-click connection
    labels, in order), ``open_connection`` (the old generic button is shown),
    ``new_connection`` and ``restore`` (those buttons are shown).
    """
    problems: list[str] = []
    saved = list(m.get("saved") or [])
    recent = list(m.get("recent") or [])
    buttons = list(m.get("buttons") or [])
    if m.get("open_connection") or OLD_OPEN_CONNECTION_LABEL in buttons:
        problems.append("the empty window still offers the generic 'Open connection…' (R-087)")
    if not buttons or buttons[0] != "New terminal":
        problems.append(f"the empty window does not start with New terminal: {buttons}")
    if saved:
        want = min(len(saved), RECENT_LIMIT)
        if len(recent) != want:
            problems.append(
                f"{len(recent)} one-click connections for {len(saved)} saved, want {want}"
            )
        unknown = [r for r in recent if r not in saved]
        if unknown:
            problems.append(f"one-click buttons that are no saved connection: {unknown}")
        if m.get("new_connection"):
            problems.append("a New connection button duplicates the sidebar's (R-107)")
        if m.get("restore"):
            problems.append("Restore from backup… shows although connections exist")
    else:
        if recent:
            problems.append(f"one-click connections without saved connections: {recent}")
        if not m.get("new_connection"):
            problems.append("a profile without connections offers no New connection")
        if not m.get("restore"):
            problems.append("a profile without connections offers no Restore from backup… (R-085)")
    return problems


# ── Live steps ───────────────────────────────────────────────────────────────
def _local_conn(name: str, home: str, zdotdir: str) -> dict[str, Any]:
    """A saved zsh connection kept off the user's real HOME and history."""
    env = [
        {"key": "HOME", "value": home},
        {"key": "ZDOTDIR", "value": zdotdir},
        {"key": "HISTFILE", "value": f"{zdotdir}/.zsh_history"},
        {"key": "SHELL_SESSION_HISTORY", "value": "0"},
    ]
    return {
        "type": "connection",
        "name": name,
        "config": {"type": "local", "config": {"shell": "zsh", "envVars": env}},
    }


@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunFirstLaunch(ProductRunUi, CrashReportUi, SystemTest):
    phase = "First launch"

    def _write_connections(self, children: list[dict[str, Any]]) -> None:
        doc = {
            "version": str(current_store_version("connections.json")),
            "agents": [],
            "children": children,
        }
        (self.config_dir / "connections.json").write_text(
            json.dumps(doc, indent=2) + "\n", encoding="utf-8"
        )

    def _seed_crash_and_connections(self) -> None:
        zdotdir = self.profile_home.parent / "first-launch-zsh"
        zdotdir.mkdir(parents=True, exist_ok=True)
        # An empty .zshrc keeps zsh-newuser-install away.
        (zdotdir / ".zshrc").write_text("PROMPT='first-launch %# '\n", encoding="utf-8")
        home, zd = str(self.profile_home), str(zdotdir)
        self._write_connections(
            [_local_conn(FIRST_CONN, home, zd), _local_conn(SECOND_CONN, home, zd)]
        )
        self.seed_local_crash_report(
            crash_report_name(),
            "termiHub product run: SEEDED crash report (not a real crash).\n"
            "It exists only so the first-launch grade sees the crash notice (#5856).\n",
        )

    def _wipe_connections(self) -> None:
        self._write_connections([])

    def _measure_empty(self, saved: list[str]) -> dict[str, Any]:
        items = self.driver.measure_element(EMPTY, "buttons")["items"]
        visible = [i for i in items if i["visible"]]
        return {
            "saved": saved,
            "buttons": [i["text"].strip() for i in visible],
            "recent": [
                i["text"].strip()
                for i in visible
                if (i.get("testId") or "").startswith(EMPTY_RECENT_PREFIX)
            ],
            "open_connection": any(
                i["text"].strip() == OLD_OPEN_CONNECTION_LABEL for i in visible
            ),
            "new_connection": self.driver.exists(EMPTY_NEW_CONNECTION),
            "restore": self.driver.exists(EMPTY_RESTORE),
        }

    def test_10_crash_notice(self):
        with self.step(
            "first-launch.crash-notice",
            "The crash notice reads View report · Close with a 'Don't tell me about future "
            "crashes' link (#5856, R-086)",
            expect="the crash banner at the bottom: View report and an outlined Close on the "
            "right, and a small underlined 'Don't tell me about future crashes' under the text",
        ):
            self.restart_app(self._seed_crash_and_connections)
            self.wait_notice_visible(CRASH_NOTICE)
            time.sleep(0.3)
            actions = []
            for tid in (CRASH_NOTICE_VIEW, CRASH_NOTICE_DISMISS):
                if self.driver.exists(tid):
                    actions.append(
                        {
                            "text": self.driver.get_text(tid).strip(),
                            "class": self.driver.get_attribute(tid, "class") or "",
                            "x": self.driver.measure_element(tid)["rect"]["x"],
                        }
                    )
            actions.sort(key=lambda a: a["x"])
            link: Optional[dict[str, Any]] = None
            if self.driver.exists(CRASH_NOTICE_NEVER):
                cls = self.driver.get_attribute(CRASH_NOTICE_NEVER, "class") or ""
                link = {
                    "text": self.driver.get_text(CRASH_NOTICE_NEVER).strip(),
                    "class": cls,
                    "in_actions": "bottom-banner__action" in cls.split(),
                }
            m = {"actions": actions, "link": link}
            self.evidence(f"crash notice {m}")
            problems = crash_notice_problems(m)
            assert not problems, "; ".join(problems)

    def test_20_recent_connections(self):
        with self.step(
            "first-launch.recent",
            "After Close, the empty window offers the saved connections as one-click buttons "
            "(#5856, R-087, R-107)",
            expect="the empty window card with New terminal and, under it, 'Your connections' "
            "listing both saved shells; no 'Open connection…' and no New connection",
        ):
            self.require("first-launch.crash-notice")
            self.driver.click(CRASH_NOTICE_DISMISS)
            self.wait(lambda: not self.driver.exists(CRASH_NOTICE), what="the banner to close")
            self.wait(lambda: self.driver.exists(EMPTY_RECENT), what="the one-click connections")
            m = self._measure_empty([FIRST_CONN, SECOND_CONN])
            self.evidence(f"empty window {m}")
            problems = empty_window_problems(m)
            assert not problems, "; ".join(problems)
        with self.step(
            "first-launch.recent.click",
            "One click on a listed connection opens it",
            expect="a terminal tab for 'First launch shell A' in place of the empty window",
        ):
            self.require("first-launch.recent")
            items = self.driver.measure_element(EMPTY_RECENT, "buttons")["items"]
            first = next(i["testId"] for i in items if i["text"].strip() == FIRST_CONN)
            self.driver.click(first)
            self.wait(lambda: not self.driver.exists(EMPTY), what="the tab to replace the card")

    def test_30_restore_offered_on_a_wiped_profile(self):
        with self.step(
            "first-launch.restore",
            "A profile without connections offers New connection and Restore from backup… "
            "(#5856, R-085)",
            expect="the empty window card with New terminal, New connection and Restore from "
            "backup…",
        ):
            self.restart_app(self._wipe_connections)
            self.wait(lambda: self.driver.exists(EMPTY_RESTORE), what="Restore from backup…")
            m = self._measure_empty([])
            self.evidence(f"empty window {m}")
            problems = empty_window_problems(m)
            assert not problems, "; ".join(problems)
        with self.step(
            "first-launch.restore.dialog",
            "Restore from backup… opens the restore dialog",
            expect="the 'Restore backup' dialog over the empty window",
        ):
            self.require("first-launch.restore")
            self.driver.click(EMPTY_RESTORE)
            self.wait(lambda: self.driver.exists(RESTORE_TITLE), what="the restore dialog")
            self.shot(label="restore-dialog", expect=RESTORE_TITLE)
            self.driver.press_key("Escape")
            self.wait(lambda: not self.driver.exists(RESTORE_TITLE), what="the dialog to close")


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
ACTION = "bottom-banner__action"


def _good_notice() -> dict[str, Any]:
    return {
        "actions": [
            {"text": "View report", "class": f"ui-btn ui-btn--ghost ui-btn--sm {ACTION}"},
            {"text": "Close", "class": f"ui-btn ui-btn--secondary ui-btn--sm {ACTION}"},
        ],
        "link": {"text": OPT_OUT_LABEL, "class": "bottom-banner__link", "in_actions": False},
    }


def test_the_new_crash_notice_passes():
    assert crash_notice_problems(_good_notice()) == []


def test_the_old_crash_notice_fails():
    # R-086: three equal buttons, the opt-out first, View report the main one.
    old = {
        "actions": [
            {"text": "Don't show again", "class": "ui-btn ui-btn--ghost bottom-banner__action"},
            {"text": "Close", "class": "ui-btn ui-btn--ghost bottom-banner__action"},
            {"text": "View report", "class": "ui-btn ui-btn--secondary bottom-banner__action"},
        ],
        "link": None,
    }
    problems = crash_notice_problems(old)
    assert any("actions read" in p for p in problems)
    assert "the outlined main action is ['View report'], want ['Close']" in problems
    assert "'Don't show again' is still a button in the action row" in problems
    assert "the crash notice has no opt-out link" in problems


def test_a_vague_opt_out_fails():
    m = _good_notice()
    m["link"]["text"] = "Don't show again"
    assert any("the opt-out reads" in p for p in crash_notice_problems(m))


def test_an_opt_out_in_the_action_row_fails():
    m = _good_notice()
    m["link"] = {"text": OPT_OUT_LABEL, "class": "ui-btn bottom-banner__action", "in_actions": True}
    problems = crash_notice_problems(m)
    assert "the opt-out link sits in the action row" in problems
    assert "the opt-out is a button, not a small link" in problems


def test_a_filled_primary_fails():
    m = _good_notice()
    m["actions"][1]["class"] = "ui-btn ui-btn--primary"
    problems = crash_notice_problems(m)
    assert "the crash notice has a filled primary (#5549)" in problems


def _good_recent() -> dict[str, Any]:
    return {
        "saved": [FIRST_CONN, SECOND_CONN],
        "buttons": ["New terminal", SECOND_CONN, FIRST_CONN],
        "recent": [SECOND_CONN, FIRST_CONN],
        "open_connection": False,
        "new_connection": False,
        "restore": False,
    }


def _good_fresh() -> dict[str, Any]:
    return {
        "saved": [],
        "buttons": ["New terminal", "New connection", "Restore from backup…"],
        "recent": [],
        "open_connection": False,
        "new_connection": True,
        "restore": True,
    }


def test_the_recent_connections_pass():
    assert empty_window_problems(_good_recent()) == []


def test_the_fresh_profile_passes():
    assert empty_window_problems(_good_fresh()) == []


def test_the_old_empty_window_fails():
    # R-087 / R-107: a generic picker button and no one-click connections.
    old = {
        "saved": [FIRST_CONN, SECOND_CONN],
        "buttons": ["New terminal", "Open connection…"],
        "recent": [],
        "open_connection": True,
        "new_connection": False,
        "restore": False,
    }
    problems = empty_window_problems(old)
    assert "the empty window still offers the generic 'Open connection…' (R-087)" in problems
    assert "0 one-click connections for 2 saved, want 2" in problems


def test_a_duplicate_new_connection_fails():
    m = _good_recent()
    m["new_connection"] = True
    assert "a New connection button duplicates the sidebar's (R-107)" in empty_window_problems(m)


def test_more_than_five_saved_offers_five():
    m = _good_recent()
    m["saved"] = [f"c{i}" for i in range(8)]
    m["recent"] = [f"c{i}" for i in range(5)]
    assert empty_window_problems(m) == []
    m["recent"] = [f"c{i}" for i in range(8)]
    assert "8 one-click connections for 8 saved, want 5" in empty_window_problems(m)


def test_a_wiped_profile_without_restore_fails():
    # R-085: nothing says a restore is possible.
    m = _good_fresh()
    m["restore"] = False
    m["buttons"] = ["New terminal", "New connection"]
    problems = empty_window_problems(m)
    assert "a profile without connections offers no Restore from backup… (R-085)" in problems


def test_restore_beside_saved_connections_fails():
    m = _good_recent()
    m["restore"] = True
    assert "Restore from backup… shows although connections exist" in empty_window_problems(m)
