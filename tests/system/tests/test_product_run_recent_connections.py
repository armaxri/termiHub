"""Product run: recent connections rank by their own last-used time (#5940).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Before #5940 the empty window's "Recent connections"
(#5856) ranked saved connections by matching session-history entries on type
and display title, so two saved connections to the same target shared one
recency: after opening the second of two local zsh shells, both read "zsh" in
the history and the first still came first.

Now every saved connection carries a ``lastUsedAt`` the backend stamps on each
successful connect, and the empty window ranks by it. A profile from before
#5940 has no stamps (absent = never used) and keeps its sidebar order until a
connection is used; a stamp is never shown on a sidebar row (#5757, "names,
not settings").

The live steps read ``connections.json``, the empty window and the sidebar;
:func:`recent_order_problems`, :func:`stamp_problems` and
:func:`row_text_problems` grade the readings and run without an app in the
normal lane (bottom of this file).
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

import pytest

from termihub_harness import SystemTest
from termihub_harness.product_run import ProductRunUi
from termihub_harness.store_versions import current_store_version
from termihub_harness.ui.lookups import connection_item_testid

EMPTY = "empty-window-state"
EMPTY_RECENT = "empty-window-recent"
EMPTY_RECENT_PREFIX = "empty-window-recent-"

#: Two saved connections that open the same target: their session-history
#: title is the same ("zsh"), which is what the old ranking keyed on.
TWIN_A = "Recent twin A"
TWIN_B = "Recent twin B"
TWINS = [TWIN_A, TWIN_B]

#: What a last-used time would look like if a row ever showed one.
_TIME_HINT = re.compile(r"\d|\bago\b|\btoday\b|\byesterday\b|\bnever\b", re.IGNORECASE)


# ── Grades (pure; unit-tested below) ─────────────────────────────────────────
def recent_order_problems(recent: list[str], want: list[str]) -> list[str]:
    """What is wrong with the empty window's one-click order, or ``[]``.

    ``recent`` is the one-click connection labels as shown, top to bottom;
    ``want`` the expected order (most recently used first).
    """
    if list(recent) == list(want):
        return []
    return [f"recent connections read {list(recent)}, want {list(want)} (#5940)"]


def stamp_problems(stamps: dict[str, Optional[int]], used: list[str]) -> list[str]:
    """What is wrong with the stored last-used times, or ``[]``.

    ``stamps`` maps each saved connection's name to its ``lastUsedAt`` in
    ``connections.json`` (``None`` when the key is absent); ``used`` names the
    connections opened so far, oldest first. Each used connection must carry
    a stamp, later ones strictly newer; every other connection must carry none
    (absent = never used, so a legacy file is not rewritten with guesses).
    """
    problems: list[str] = []
    previous: Optional[int] = None
    for name in used:
        at = stamps.get(name)
        if not isinstance(at, int) or isinstance(at, bool) or at <= 0:
            problems.append(f"{name!r} was opened but stores no lastUsedAt ({at!r})")
            continue
        if previous is not None and at <= previous:
            problems.append(f"{name!r} stores lastUsedAt {at}, not newer than {previous}")
        previous = at
    for name, at in stamps.items():
        if name not in used and at is not None:
            problems.append(f"{name!r} was never opened but stores lastUsedAt {at}")
    return problems


def row_text_problems(rows: dict[str, str]) -> list[str]:
    """What is wrong with the sidebar rows, or ``[]`` (#5757, #5940).

    ``rows`` maps each connection's name to its sidebar row text. A row shows
    the name only: never a last-used time.
    """
    problems: list[str] = []
    for name, text in rows.items():
        shown = " ".join(text.split())
        if shown != name:
            extra = shown.replace(name, "", 1).strip()
            problems.append(f"the {name!r} row reads {shown!r}, want just the name")
            if _TIME_HINT.search(extra):
                problems.append(f"the {name!r} row shows a time: {extra!r}")
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
class TestProductRunRecentConnections(ProductRunUi, SystemTest):
    phase = "Recent connections"

    def _seed_legacy_twins(self) -> None:
        """A pre-#5940 ``connections.json``: two twins, no ``lastUsedAt``."""
        zdotdir = self.profile_home.parent / "recent-connections-zsh"
        zdotdir.mkdir(parents=True, exist_ok=True)
        # An empty .zshrc keeps zsh-newuser-install away.
        (zdotdir / ".zshrc").write_text("PROMPT='recent %# '\n", encoding="utf-8")
        home, zd = str(self.profile_home), str(zdotdir)
        doc = {
            "version": str(current_store_version("connections.json")),
            "agents": [],
            "children": [_local_conn(name, home, zd) for name in TWINS],
        }
        (self.config_dir / "connections.json").write_text(
            json.dumps(doc, indent=2) + "\n", encoding="utf-8"
        )

    def _stored_stamps(self) -> dict[str, Optional[int]]:
        doc = json.loads((self.config_dir / "connections.json").read_text(encoding="utf-8"))
        return {
            node["name"]: node.get("lastUsedAt")
            for node in doc.get("children", [])
            if node.get("type") == "connection"
        }

    def _recent(self) -> list[str]:
        items = self.driver.measure_element(EMPTY_RECENT, "buttons")["items"]
        return [
            i["text"].strip()
            for i in items
            if i["visible"] and (i.get("testId") or "").startswith(EMPTY_RECENT_PREFIX)
        ]

    def _open_and_close(self, name: str, used: list[str]) -> None:
        """Open ``name`` from the sidebar, wait for its stamp, then close it."""
        self.connect_connection(name)
        self.wait(lambda: not self.driver.exists(EMPTY), what=f"a tab for {name!r}")
        self.wait(
            lambda: not stamp_problems(self._stored_stamps(), used),
            what=f"{name!r} to store its last-used time",
        )
        self.close_all_tabs()
        self.wait(lambda: self.driver.exists(EMPTY_RECENT), what="the empty window")

    def _grade_after(self, used: list[str], want: list[str]) -> None:
        stamps = self._stored_stamps()
        recent = self._recent()
        self.evidence(f"stamps {stamps}; recent {recent}")
        problems = stamp_problems(stamps, used) + recent_order_problems(recent, want)
        assert not problems, "; ".join(problems)

    def test_10_legacy_profile_is_never_used(self):
        with self.step(
            "recent.legacy",
            "A profile from before #5940 loads with no last-used times and keeps the "
            "sidebar order (#5940)",
            expect="the empty window listing Recent twin A, then Recent twin B",
        ):
            self.restart_app(self._seed_legacy_twins)
            self.wait(lambda: self.driver.exists(EMPTY_RECENT), what="the one-click connections")
            self._grade_after(used=[], want=[TWIN_A, TWIN_B])

    def test_20_the_second_twin_moves_up(self):
        with self.step(
            "recent.second-twin",
            "Opening the second of two connections to the same shell ranks it first (#5940)",
            expect="the empty window listing Recent twin B above Recent twin A",
        ):
            self.require("recent.legacy")
            self._open_and_close(TWIN_B, [TWIN_B])
            self._grade_after(used=[TWIN_B], want=[TWIN_B, TWIN_A])

    def test_30_the_first_twin_moves_back_up(self):
        with self.step(
            "recent.first-twin",
            "Opening the other twin ranks it first again, each keeping its own time (#5940)",
            expect="the empty window listing Recent twin A above Recent twin B",
        ):
            self.require("recent.second-twin")
            self._open_and_close(TWIN_A, [TWIN_B, TWIN_A])
            self._grade_after(used=[TWIN_B, TWIN_A], want=[TWIN_A, TWIN_B])

    def test_40_rows_never_show_the_time(self):
        with self.step(
            "recent.rows",
            "Sidebar rows show the connection names only, never a last-used time "
            "(#5757, #5940)",
            expect="the Connections sidebar with two rows reading just 'Recent twin A' and "
            "'Recent twin B'",
        ):
            self.require("recent.first-twin")
            rows = {}
            for name in TWINS:
                conn = self.require_connection(name)
                rows[name] = self.driver.get_text(connection_item_testid(conn["id"]))
            self.evidence(f"rows {rows}")
            problems = row_text_problems(rows)
            assert not problems, "; ".join(problems)


# ── Per-PR grade checks (no app) ─────────────────────────────────────────────
def test_the_expected_order_passes():
    assert recent_order_problems([TWIN_B, TWIN_A], [TWIN_B, TWIN_A]) == []


def test_the_old_title_ranking_fails():
    # Before #5940 both twins shared the "zsh" history entry, so the sidebar
    # order won the tie and the twin just opened stayed second.
    assert recent_order_problems([TWIN_A, TWIN_B], [TWIN_B, TWIN_A]) == [
        f"recent connections read {[TWIN_A, TWIN_B]}, want {[TWIN_B, TWIN_A]} (#5940)"
    ]


def test_a_legacy_file_with_no_stamps_passes():
    assert stamp_problems({TWIN_A: None, TWIN_B: None}, []) == []


def test_stamps_in_use_order_pass():
    assert stamp_problems({TWIN_A: 2_000, TWIN_B: 1_000}, [TWIN_B, TWIN_A]) == []


def test_an_opened_connection_without_a_stamp_fails():
    problems = stamp_problems({TWIN_A: None, TWIN_B: None}, [TWIN_B])
    assert problems == [f"{TWIN_B!r} was opened but stores no lastUsedAt (None)"]


def test_a_never_opened_connection_with_a_stamp_fails():
    # A migration that seeded a guess, or a twin credited with the other's use.
    problems = stamp_problems({TWIN_A: 1_000, TWIN_B: 1_000}, [TWIN_B])
    assert problems == [f"{TWIN_A!r} was never opened but stores lastUsedAt 1000"]


def test_a_stamp_that_did_not_move_forward_fails():
    problems = stamp_problems({TWIN_A: 1_000, TWIN_B: 1_000}, [TWIN_B, TWIN_A])
    assert problems == [f"{TWIN_A!r} stores lastUsedAt 1000, not newer than 1000"]


def test_a_non_numeric_stamp_fails():
    problems = stamp_problems({TWIN_A: None, TWIN_B: True}, [TWIN_B])  # type: ignore[dict-item]
    assert problems == [f"{TWIN_B!r} was opened but stores no lastUsedAt (True)"]


def test_rows_with_just_the_name_pass():
    assert row_text_problems({TWIN_A: TWIN_A, TWIN_B: f"  {TWIN_B}\n"}) == []


def test_a_row_showing_the_last_used_time_fails():
    problems = row_text_problems({TWIN_A: f"{TWIN_A} 5 minutes ago"})
    assert f"the {TWIN_A!r} row reads '{TWIN_A} 5 minutes ago', want just the name" in problems
    assert f"the {TWIN_A!r} row shows a time: '5 minutes ago'" in problems


def test_a_row_with_other_extra_text_fails_without_a_time_claim():
    problems = row_text_problems({TWIN_A: f"{TWIN_A} zsh"})
    assert problems == [f"the {TWIN_A!r} row reads '{TWIN_A} zsh', want just the name"]
