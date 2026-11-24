"""Product run: closing several tabs leaves one reopen toast (#5828).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw three identical "Closed “Terminal” · Reopen" toasts
stacked over the connection editor (R-010): nobody could tell which Reopen
restored which tab, and they hid the Shell, Starting directory and Initial
command fields. Closes within a short window now share ONE toast, replaced in
place: a single close names the tab ("Closed “web”" · Reopen), several read
"Closed 3 tabs" · Reopen all, which restores every tab in the order it was
closed. The toast still stays clear of the editor's Save / Cancel footer.

The grade uses local-shell connections with distinct names, exits each shell
first (an exited tab closes at once, without a live session's confirm dialog,
which would hide the reopen toast until it closes, #5914), then closes the
tabs with the connection editor open. No servers needed.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any

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
from termihub_harness.product_run.reopen_toast import (
    closed_titles,
    expected_action,
    expected_message,
    reopen_order_problems,
    reopen_toast_problems,
)

TOAST_REGION = "toast-region"
#: The reopen toast's action label testId (``src/utils/reopenTab.ts``).
REOPEN_ACTION = "reopen-tab-toast-action"
EDITOR_FOOTER = "connection-editor-actions"
#: How many tabs the multi-close step closes in a row.
CLOSES = 3


# ── app-free grade tests ──────────────────────────────────────────────────
def _item(text: str, y: float, *, x: float = 900.0, width: float = 300.0, label: str = ""):
    rect = {"x": x, "y": y, "width": width, "height": 20.0}
    return {"text": text, "label": label, "rect": rect}


def _footer(y: float = 760.0):
    return [_item("Cancel", y, x=1000.0, width=80.0), _item("Save", y, x=1100.0, width=80.0)]


def test_grade_copy_matches_the_app():
    assert expected_message(["web"]) == "Closed “web”"
    assert expected_message(["a", "b", "c"]) == "Closed 3 tabs"
    assert expected_action(["web"]) == "Reopen"
    assert expected_action(["a", "b"]) == "Reopen all"


def test_grade_one_coalesced_toast_passes():
    items = [_item("Closed 3 tabs", 600), _item("a, b, c", 622), _item("Reopen all", 640)]
    assert reopen_toast_problems(items, ["a", "b", "c"], _footer()) == []


def test_grade_single_close_names_the_tab():
    items = [_item("Closed “web”", 600), _item("Reopen", 640)]
    assert reopen_toast_problems(items, ["web"], _footer()) == []
    wrong = [_item("Closed 1 tabs", 600), _item("Reopen", 640)]
    assert any("want 'Closed “web”'" in p for p in reopen_toast_problems(wrong, ["web"]))


def test_grade_stacked_toasts_fail():
    # The R-010 shape: one identical toast per closed tab.
    items = []
    for i in range(3):
        items += [_item("Closed “Terminal”", 500 + 60 * i), _item("Reopen", 520 + 60 * i)]
    problems = reopen_toast_problems(items, ["Terminal"] * 3, _footer())
    assert any("3 'Closed …' toasts stack" in p for p in problems)
    assert any("want 'Closed 3 tabs'" in p for p in problems)
    assert any("'Reopen all'" in p for p in problems)


def test_grade_missing_toast_or_covered_footer_fails():
    assert reopen_toast_problems([], ["a"]) == ["no 'Closed …' toast after closing 1 tab(s)"]
    items = [_item("Closed “web”", 755), _item("Reopen", 640)]
    assert any("covers the footer" in p for p in reopen_toast_problems(items, ["web"], _footer()))


def test_grade_closed_titles_ignores_other_toasts():
    items = [_item("Saved", 500), _item("Closed 2 tabs", 560)]
    assert [i["text"] for i in closed_titles(items)] == ["Closed 2 tabs"]


def test_grade_reopen_order():
    assert reopen_order_problems(["a", "b", "c"], ["a", "b", "c"]) == []
    assert any("out of order" in p for p in reopen_order_problems(["a", "b", "c"], ["c", "b", "a"]))
    assert any("want all of" in p for p in reopen_order_problems(["a", "b", "c"], ["c"]))


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunReopenToast(
    ProductRunUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Reopen toast"
    request_timeout = 90.0

    def _toast_items(self) -> list[dict[str, Any]]:
        """The visible text and button items inside the toast stack."""
        if not self.driver.exists(TOAST_REGION):
            return []
        items: list[dict[str, Any]] = []
        for kind in ("text", "buttons"):
            items += [
                i
                for i in self.driver.measure_element(TOAST_REGION, kind)["items"]
                if i["visible"] and i["rect"]["width"] > 2 and i["rect"]["height"] > 2
            ]
        return items

    def _exited_connection_tab(self, name: str) -> str:
        """Open local connection ``name``, end its shell, and return the tab id."""
        before = self.tab_ids()
        self.create_local_connection(name, connect=True)
        tab = self.wait(
            lambda: next(
                (
                    t["id"]
                    for t in self._all_tabs()
                    if t["id"] not in before and t.get("title") == name
                ),
                None,
            ),
            what=f"the {name!r} terminal",
        )
        self.switch_to_tab(tab)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        self.run_command("exit")
        self.wait(lambda: self.terminal_session_exited(tab), what=f"the {name!r} shell to exit")
        return tab

    def _wait_for_toast(self, closed: list[str]) -> list[dict[str, Any]]:
        want = expected_message(closed)
        return self.wait(
            lambda: (lambda items: items if any(i["text"] == want for i in items) else None)(
                self._toast_items()
            ),
            timeout=5.0,
            what=f"the {want!r} toast",
        )

    def _reopen(self, closed: list[str]) -> None:
        before = self.tab_ids()
        self.driver.click(REOPEN_ACTION)
        new = self.wait(
            lambda: (lambda ids: ids if len(ids) >= len(closed) else None)(
                [t for t in self.tab_ids() if t not in before]
            ),
            what=f"{len(closed)} reopened tab(s)",
        )
        titles = {t["id"]: t.get("title", "") for t in self._all_tabs()}
        reopened = [titles[t] for t in self.tab_ids() if t in new]
        self.evidence(f"reopened tabs {reopened}")
        problems = reopen_order_problems(closed, reopened)
        assert not problems, problems

    def test_10_single_close_names_the_tab(self):
        with self.step(
            "toasts.reopen.single",
            "Closing one tab shows one toast naming it, and Reopen brings it back (#5828)",
            expect="one toast reading 'Closed “sys-pr-reopen-…”' with a Reopen button",
        ):
            self.switch_to_connections_sidebar()
            name = unique_name("pr-reopen")
            tab = self._exited_connection_tab(name)
            self.close_tab(tab)
            items = self._wait_for_toast([name])
            self.evidence(f"toast items {[(i['text'] or i.get('label'), i['rect']) for i in items]}")
            problems = reopen_toast_problems(items, [name])
            assert not problems, problems
            self._reopen([name])
        self.close_all_tabs()

    def test_20_several_closes_share_one_toast(self):
        with self.step(
            "toasts.reopen.coalesced",
            f"Closing {CLOSES} tabs over the connection editor leaves ONE toast, "
            "'Closed 3 tabs' · Reopen all, clear of the footer (#5828)",
            expect=f"the connection editor with a single toast 'Closed {CLOSES} tabs' listing "
            "the three tab names and a 'Reopen all' button; no stacked 'Closed …' toasts, "
            "Save / Cancel uncovered",
        ):
            self.switch_to_connections_sidebar()
            names = [unique_name("pr-reopen") for _ in range(CLOSES)]
            tabs = [self._exited_connection_tab(n) for n in names]
            self.open_new_connection_editor()
            for tab in tabs:
                self.close_tab(tab)
            items = self._wait_for_toast(names)
            self.shot(label="coalesced")
            self.evidence(f"toast items {[(i['text'] or i.get('label'), i['rect']) for i in items]}")
            footer = [
                b
                for b in self.driver.measure_element(EDITOR_FOOTER, "buttons")["items"]
                if b["visible"] and b["rect"]["width"] > 2
            ]
            assert footer, "the editor footer shows no buttons"
            problems = reopen_toast_problems(items, names, footer)
            assert not problems, problems
            self._reopen(names)
        self.close_all_tabs()
