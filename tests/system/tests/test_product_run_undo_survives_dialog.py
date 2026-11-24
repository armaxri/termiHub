"""Product run: an undo offer survives a dialog opening (#5914).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). Under #5830 opening any dialog
dismissed every success toast still showing, undo offers included: closing a
tab and then opening an unrelated dialog lost its "Closed … · Reopen". An
undo offer is now hidden while the dialog is open (it would sit over the
backdrop that blocks its button) and shown again, with the lifetime it had
left, once the dialog closes. The reopen toast no longer asks to be dismissed
by a dialog (#5665 reviewed under the same rule).

The grade closes an exited local terminal, opens the workflow editor, reads
the toast stack while it is open, cancels it, and presses Reopen on the toast
that came back. A second step (#5919) closes another tab right after the
dialog, more than the 6 s coalesce window after the first close: it must join
the toast still on offer ("Closed 2 tabs" · Reopen all), not replace it. No
servers needed.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import sys
import time
from typing import Any

import pytest

from termihub_harness import (
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.reopen_toast import expected_message
from termihub_harness.product_run.undo_dialog import (
    offer_shown,
    undo_across_dialog_problems,
)

TOAST_REGION = "toast-region"
#: The reopen toast's action label testId (``src/utils/reopenTab.ts``).
REOPEN_ACTION = "reopen-tab-toast-action"


# ── app-free grade tests ──────────────────────────────────────────────────
def _items(*texts: str) -> list[dict[str, Any]]:
    return [{"text": t, "rect": {"x": 900.0, "y": 600.0, "width": 200.0, "height": 20.0}} for t in texts]


TITLE = "Closed “web”"


def test_grade_offer_kept_across_the_dialog_passes():
    before = _items(TITLE, "Reopen")
    after = _items(TITLE, "Reopen")
    assert undo_across_dialog_problems(before, [], after, TITLE, "Reopen") == []


def test_grade_offer_lost_to_the_dialog_fails():
    # The #5914 shape: the dialog took the offer down for good.
    problems = undo_across_dialog_problems(_items(TITLE, "Reopen"), [], [], TITLE, "Reopen")
    assert any("did not come back" in p for p in problems)


def test_grade_offer_beside_the_open_dialog_fails():
    problems = undo_across_dialog_problems(
        _items(TITLE, "Reopen"), _items(TITLE, "Reopen"), _items(TITLE, "Reopen"), TITLE, "Reopen"
    )
    assert problems == [f"the {TITLE!r} toast shows beside the open dialog (want it hidden)"]


def test_grade_offer_back_without_its_button_fails():
    problems = undo_across_dialog_problems(
        _items(TITLE, "Reopen"), [], _items(TITLE), TITLE, "Reopen"
    )
    assert any("did not come back" in p for p in problems)


def test_grade_offer_back_twice_fails():
    problems = undo_across_dialog_problems(
        _items(TITLE, "Reopen"), [], _items(TITLE, "Reopen", TITLE, "Reopen"), TITLE, "Reopen"
    )
    assert any("2 'Closed “web”' toasts" in p for p in problems)


def test_grade_missing_offer_before_the_dialog_fails():
    problems = undo_across_dialog_problems([], [], _items(TITLE, "Reopen"), TITLE, "Reopen")
    assert any("before the dialog opened" in p for p in problems)


def test_grade_offer_shown_reads_labels_too():
    items = [{"text": TITLE}, {"text": "", "label": "Reopen"}]
    assert offer_shown(items, TITLE, "Reopen")
    assert not offer_shown(items, TITLE, "Undo")


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the grade exits a POSIX shell")
class TestProductRunUndoSurvivesDialog(
    ProductRunUi, WorkflowUi, SettingsUi, TerminalUi, TabsUi, SidebarUi, SystemTest
):
    phase = "Undo survives a dialog"
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

    def _offer_items(self, title: str) -> list[dict[str, Any]] | None:
        items = self._toast_items()
        return items if offer_shown(items, title, "Reopen") else None

    def _exited_terminal(self) -> tuple[str, str]:
        """Open a local terminal, end its shell, and return its id and title."""
        before_tabs = self.tab_ids()
        self.open_new_terminal()
        self.wait(lambda: len(self.tab_ids()) == len(before_tabs) + 1, what="a terminal")
        tab = next(t for t in self.tab_ids() if t not in before_tabs)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        title = next(t.get("title", "") for t in self._all_tabs() if t["id"] == tab)
        # An exited tab closes at once, without its confirm dialog.
        self.run_command("exit")
        self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
        return tab, title

    def test_20_close_after_a_slow_dialog_joins_the_toast(self):
        with self.step(
            "toasts.undo.dialog-join",
            "A tab closed after a long dialog joins the 'Closed …' toast still on offer (#5919)",
            expect="#5919: one 'Closed 2 tabs' toast with Reopen all, which restores both tabs; "
            "the first tab's undo is not replaced by the second close",
        ):
            self.enable_experimental_features()
            self.open_workflows_sidebar()
            first, first_title = self._exited_terminal()
            second, second_title = self._exited_terminal()
            self.close_tab(first)
            self.wait(
                lambda: self._offer_items(f"Closed “{first_title}”"), timeout=5.0, what="the toast"
            )
            self.open_new_workflow()
            # Longer than the 6 s coalesce window, measured from the first close.
            time.sleep(7.0)
            self.cancel_clean_editor()
            self.close_tab(second)
            want = expected_message([first_title, second_title])
            items = self.wait(
                lambda: (lambda i: i if offer_shown(i, want, "Reopen all") else None)(
                    self._toast_items()
                ),
                timeout=5.0,
                what=f"the {want!r} toast",
            )
            self.evidence(f"toast items {[i['text'] or i.get('label') for i in items]}")
            self.shot(label="joined")
            closed = [i for i in items if (i.get("text") or "").startswith("Closed")]
            assert len(closed) == 1, f"want one 'Closed …' toast, saw {[i['text'] for i in closed]}"
            open_before = self.tab_ids()
            self.driver.click(REOPEN_ACTION)
            self.wait(
                lambda: len([t for t in self.tab_ids() if t not in open_before]) >= 2,
                what="both reopened tabs",
            )
        self.close_all_tabs()

    def test_10_reopen_toast_survives_a_dialog(self):
        with self.step(
            "toasts.undo.dialog",
            "A 'Closed … · Reopen' toast hides while a dialog is open and comes back, "
            "still working, once it closes (#5914)",
            expect="#5914: after cancelling the workflow editor the 'Closed “Terminal”' toast "
            "is back with its Reopen button, and Reopen restores the tab",
        ):
            # Open the dialog's sidebar first: the toast lifetime runs until
            # the dialog opens, so nothing slow may sit between.
            self.enable_experimental_features()
            self.open_workflows_sidebar()
            before_tabs = self.tab_ids()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before_tabs) + 1, what="a terminal")
            tab = next(t for t in self.tab_ids() if t not in before_tabs)
            self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
            title = next(
                f"Closed “{t.get('title', '')}”" for t in self._all_tabs() if t["id"] == tab
            )
            # An exited tab closes at once, without its confirm dialog.
            self.run_command("exit")
            self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
            self.close_tab(tab)
            before = self.wait(lambda: self._offer_items(title), timeout=5.0, what=title)

            self.open_new_workflow()
            # Longer than the toast's own 6 s lifetime: dialog time must not count.
            time.sleep(1.0)
            during = self._toast_items()
            self.shot(label="dialog-open")
            time.sleep(6.0)
            self.cancel_clean_editor()
            after = self.wait(
                lambda: self._offer_items(title), timeout=5.0, what=f"{title} back"
            )
            self.evidence(
                f"before {[i['text'] for i in before]}; during {[i['text'] for i in during]}; "
                f"after {[i['text'] for i in after]}"
            )
            self.shot(label="dialog-closed")
            problems = undo_across_dialog_problems(before, during, after, title, "Reopen")
            assert not problems, problems

            open_before = self.tab_ids()
            self.driver.click(REOPEN_ACTION)
            self.wait(lambda: len(self.tab_ids()) > len(open_before), what="the reopened tab")
        self.close_all_tabs()
