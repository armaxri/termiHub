"""Product run: narrow tabs keep the part that tells them apart (#5827).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw the "(2)" counter of a duplicate tab cut off (R-008),
the two tabs of one connection apart in the strip, and two telnet tabs both
reading "sys-pr-tel… Unencrypted" (R-009, R-070). Tab titles are now
middle-truncated: the end of the name and the counter always stay visible, a
duplicate session opens beside its sibling, and the telnet marker is an icon
(graded on the telnet tab in ``test_product_run_telnet_unencrypted.py``).

The grade uses local-shell connections whose names share a long prefix and
differ only in their last characters, like the run's ``sys-pr-telnet-<hex>``
names: it opens both, a second session of the first, then shrinks the window
to its 800x600 minimum and fills the strip until the titles truncate, and
reads each tab's head and tail. No servers needed.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.tab_labels import (
    expected_tail,
    head_clipped,
    measure_tab_label,
    tab_label_problems,
)

#: The minimum supported window, where a full strip compresses its tabs.
NARROW_WINDOW = (800, 600)
#: The product run's normal window, restored afterwards.
NORMAL_WINDOW = (1280, 800)
#: Filler terminals opened at most to make the strip truncate the titles.
MAX_FILLERS = 14


# ── app-free grade tests ──────────────────────────────────────────────────
def _box(x: float, width: float) -> dict[str, float]:
    return {"x": x, "y": 10.0, "width": width, "height": 20.0}


def _tab(title: str, tail: str | None, *, x: float = 0.0, clipped: bool = True,
         tail_x: float | None = None, tail_clipped: bool = False) -> dict:
    head = {
        "text": title[: len(title) - len(tail or "")],
        "scrollWidth": 200.0 if clipped else 60.0,
        "clientWidth": 60.0,
    }
    measured_tail = None
    if tail is not None:
        measured_tail = {
            "text": tail.strip(),
            "rect": _box(x + 70.0 if tail_x is None else tail_x, 40.0),
            "scrollWidth": 60.0 if tail_clipped else 40.0,
            "clientWidth": 40.0,
        }
    return {"id": title, "title": title, "tab": _box(x, 120.0), "head": head,
            "tail": measured_tail}


def test_grade_expected_tail_matches_the_app_split():
    assert expected_tail("sys-pr-telnet-0d8db725") == "0d8db725"
    assert expected_tail("sys-pr-ssh-dup-0d8db725 (2)") == "0d8db725 (2)"
    assert expected_tail("web (3)") == " (3)"
    assert expected_tail("Lab switch") == ""


def test_grade_distinct_tails_pass():
    tabs = [
        _tab("sys-pr-tab-label-1a2b3c4d", "1a2b3c4d"),
        _tab("sys-pr-tab-label-9f8e7d6c", "9f8e7d6c", x=120.0),
        _tab("sys-pr-tab-label-1a2b3c4d (2)", "1a2b3c4d (2)", x=240.0),
    ]
    assert tab_label_problems(tabs) == []


def test_grade_end_truncated_titles_fail():
    # The R-009 shape: no tail, so both tabs read the same prefix.
    tabs = [_tab("sys-pr-telnet-1a2b3c4d", None), _tab("sys-pr-telnet-9f8e7d6c", None, x=120.0)]
    problems = tab_label_problems(tabs)
    assert any("no always-visible tail" in p for p in problems)
    assert any("both read" in p for p in problems)


def test_grade_cut_counter_fails():
    # The R-008 shape: the counter is cut from the tail.
    problems = tab_label_problems([_tab("sys-pr-ssh-dup-0d8db725 (2)", "0d8db725 (")])
    assert any("want '0d8db725 (2)'" in p for p in problems)


def test_grade_clipped_or_escaping_tail_fails():
    assert any("clipped" in p for p in tab_label_problems(
        [_tab("sys-pr-tab-label-1a2b3c4d", "1a2b3c4d", tail_clipped=True)]))
    assert any("outside its tab" in p for p in tab_label_problems(
        [_tab("sys-pr-tab-label-1a2b3c4d", "1a2b3c4d", tail_x=100.0)]))


def test_grade_short_untruncated_titles_pass():
    tabs = [_tab("web", None, clipped=False), _tab("db", None, x=120.0, clipped=False)]
    assert tab_label_problems(tabs) == []
    assert not head_clipped(tabs[0])


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunTabLabelTruncation(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Tab labels"
    request_timeout = 90.0
    names: dict[str, str] = {}

    def reset_before_rerun(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)

    def _tabs_titled(self, title: str) -> list[str]:
        return [t["id"] for t in self._all_tabs() if t.get("title") == title]

    def _labels(self, ids: list[str]) -> list[dict]:
        return [measure_tab_label(self.driver, tab_id, self._tooltip(tab_id)) for tab_id in ids]

    def _tooltip(self, tab_id: str) -> str:
        return self.driver.get_attribute(f"tab-{tab_id}", "title") or ""

    def test_10_duplicate_opens_beside_its_sibling(self):
        first, other = unique_name("pr-tab-label"), unique_name("pr-tab-label")
        type(self).names = {"first": first, "other": other}
        with self.step(
            "tabs.labels.duplicate-adjacent",
            "A second session of a connection opens right after the first (#5827)",
            expect="the strip reads <name>, <name> (2), <other name>: the duplicate beside "
            "its sibling, not at the end",
        ):
            self.switch_to_connections_sidebar()
            for name in (first, other):
                self.create_local_connection(name, connect=True)
                self.wait(lambda n=name: self._tabs_titled(n) or None, what=f"the {name!r} tab")
            self.connect_connection(first)
            dups = self.wait(
                lambda: (lambda ts: ts if len(ts) >= 2 else None)(self._tabs_titled(first)),
                what=f"a second {first!r} tab",
            )
            order = self.tab_ids()
            positions = [order.index(tab_id) for tab_id in dups]
            self.evidence(f"strip order {order}; {first!r} tabs at {positions}")
            assert positions[1] == positions[0] + 1, (
                f"the duplicate {first!r} tab is at {positions[1]}, not beside {positions[0]}"
            )
            assert order.index(self._tabs_titled(other)[0]) > positions[1], order

    def test_20_narrow_tabs_keep_their_tails(self):
        with self.step(
            "tabs.labels.narrow",
            "In a full strip at 800x600 the titles truncate in the middle: each keeps the "
            "end of its name and its '(2)' counter (#5827)",
            expect="compressed tabs reading 'sys-pr-tab-…<8 hex>', "
            "'sys-pr-tab-…<8 hex> (2)' and 'sys-pr-tab-…<other 8 hex>'; "
            "the full name in each tab's tooltip",
        ):
            self.require("tabs.labels.duplicate-adjacent")
            first, other = self.names["first"], self.names["other"]
            ids = self._tabs_titled(first) + self._tabs_titled(other)
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                for _ in range(MAX_FILLERS):
                    if all(head_clipped(t) for t in self._labels(ids)):
                        break
                    self.open_new_terminal()
                labels = self.wait(
                    lambda: (lambda ls: ls if all(head_clipped(t) for t in ls) else None)(
                        self._labels(ids)
                    ),
                    timeout=15.0,
                    what="the strip to truncate the connection tabs' titles",
                )
                self.switch_to_tab(ids[1])
                self.shot(label="narrow-strip")
                for label in labels:
                    self.evidence(
                        f"{label['title']!r}: tab {label['tab']['width']:.0f}px, head "
                        f"{(label['head'] or {}).get('text')!r}, tail "
                        f"{(label['tail'] or {}).get('text')!r}"
                    )
                assert labels[1]["title"].endswith("(2)"), labels[1]["title"]
                problems = tab_label_problems(labels)
                assert not problems, problems
            finally:
                self.driver.resize_window(*NORMAL_WINDOW)
        self.close_all_tabs()
