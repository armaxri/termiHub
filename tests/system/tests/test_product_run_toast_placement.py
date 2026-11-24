"""Product run: toasts keep clear of editor forms and the status bar (#5830).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` saw a "Closed “Terminal” · Reopen" toast over the
connection editor's Initial command field (R-064), a success toast over the
status bar's lock indicator (R-163), and stale "Played macro…" / "Disabled
schedule…" toasts lingering next to a new confirm dialog (R-168).

Now the status bar is a toast keep-clear zone, so the stack always starts
above it; while an editor's form sits where the stack would go, the stack is
pinned top-right just above the form (over the editor's title strip), one
compact toast at a time; and a dialog opening dismisses the success/info
toasts still showing. Feedback raised inside a dialog shows in its inline
status line (component-tested; no product action routes through it yet).

The live steps run at the 800x600 minimum window, where the stack has the
least room. No servers needed: local shells and the workflow editor are enough.

The ``test_grade_*`` functions grade fixed measurements without an app and run
in the normal lane.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
)
from termihub_harness.product_run import ProductRunUi

TOAST_REGION = "toast-region"
STATUS_BAR = "status-bar"
EDITOR_FORM = "connection-editor-body"
EDITOR_FOOTER = "connection-editor-actions"
WORKFLOW_DIALOG = "workflow-editor-dialog"
#: The minimum supported window, where the stack has the least room.
NARROW_WINDOW = (800, 600)
#: The product run's normal window, restored afterwards.
NORMAL_WINDOW = (1280, 800)
EPS = 0.5

Rect = dict[str, float]


# ── grading ───────────────────────────────────────────────────────────────
def _intersects(a: Rect, b: Rect) -> bool:
    """The two viewport boxes overlap by more than the rounding slack."""
    return (
        a["x"] < b["x"] + b["width"] - EPS
        and b["x"] < a["x"] + a["width"] - EPS
        and a["y"] < b["y"] + b["height"] - EPS
        and b["y"] < a["y"] + a["height"] - EPS
    )


def _shown(item: dict[str, Any]) -> bool:
    """Rendered and bigger than a screen-reader-only 1 px box."""
    return bool(item.get("visible", True)) and item["rect"]["width"] > 2 and item["rect"]["height"] > 2


def placement_problems(toasts: list[dict[str, Any]], keep_clear: dict[str, Rect]) -> list[str]:
    """Every toast item (text or button) that covers one of the ``keep_clear`` boxes."""
    problems = []
    for item in toasts:
        if not _shown(item):
            continue
        label = item.get("text") or item.get("label") or "?"
        for name, box in keep_clear.items():
            if _intersects(item["rect"], box):
                problems.append(f"toast {label!r} {item['rect']} covers the {name} {box}")
    return problems


def stale_toast_problems(toasts: list[dict[str, Any]], stale: list[str]) -> list[str]:
    """Each toast from before a dialog opened that still shows beside it."""
    texts = [i.get("text", "") for i in toasts if _shown(i)]
    return [
        f"the stale {s!r} toast still shows beside the dialog"
        for s in stale
        if any(t.startswith(s) for t in texts)
    ]


# ── app-free grade tests ──────────────────────────────────────────────────
def _rect(x: float, y: float, width: float, height: float) -> Rect:
    return {"x": x, "y": y, "width": width, "height": height}


def _item(text: str, rect: Rect) -> dict[str, Any]:
    return {"text": text, "label": "", "visible": True, "rect": rect}


STATUS = _rect(0, 576, 800, 24)
FORM = _rect(48, 104, 752, 424)


def test_grade_toast_above_status_bar_passes():
    toast = _item("Credential store unlocked", _rect(444, 500, 340, 40))
    assert placement_problems([toast], {"status bar": STATUS}) == []


def test_grade_toast_over_lock_indicator_fails():
    toast = _item("Credential store unlocked", _rect(444, 556, 340, 40))
    problems = placement_problems([toast], {"status bar": STATUS})
    assert len(problems) == 1 and "status bar" in problems[0]


def test_grade_pinned_toast_above_form_passes():
    toast = _item("Closed “Terminal”", _rect(444, 70, 340, 32))
    assert placement_problems([toast], {"editor form": FORM, "status bar": STATUS}) == []


def test_grade_toast_over_form_fields_fails():
    toast = _item("Closed “Terminal”", _rect(444, 440, 340, 60))
    problems = placement_problems([toast], {"editor form": FORM})
    assert problems and "editor form" in problems[0]


def test_grade_ignores_hidden_and_touching_items():
    hidden = {**_item("sr only", _rect(500, 300, 1, 1)), "visible": True}
    touching = _item("Saved", _rect(444, 64, 340, 40))  # bottom edge == form top
    assert placement_problems([hidden, touching], {"editor form": FORM}) == []


def test_grade_stale_toasts_beside_a_dialog_fail():
    toasts = [_item("Played macro “deploy”", _rect(444, 500, 340, 40))]
    problems = stale_toast_problems(toasts, ["Played macro", "Disabled schedule"])
    assert problems == ["the stale 'Played macro' toast still shows beside the dialog"]
    assert stale_toast_problems([], ["Played macro"]) == []


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
class TestProductRunToastPlacement(
    ProductRunUi,
    WorkflowUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Toast placement"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)

    def _toast_items(self) -> list[dict[str, Any]]:
        """The visible text and button boxes inside the toast stack."""
        if not self.driver.exists(TOAST_REGION):
            return []
        items: list[dict[str, Any]] = []
        for kind in ("text", "buttons"):
            items += [i for i in self.driver.measure_element(TOAST_REGION, kind)["items"] if _shown(i)]
        return items

    def _closed_toast(self) -> list[dict[str, Any]] | None:
        items = self._toast_items()
        return items if any(i["text"].startswith("Closed") for i in items) else None

    def _rect_of(self, test_id: str) -> Rect:
        return self.driver.measure_element(test_id)["rect"]

    def _exited_tab(self) -> str:
        """A local terminal whose shell has exited, so closing it asks nothing."""
        before = self.tab_ids()
        self.ensure_terminal()
        tab = self.wait(
            lambda: next((t for t in self.tab_ids() if t not in before), None)
            or (self.tab_ids()[-1] if self.tab_ids() else None),
            what="a terminal tab",
        )
        self.switch_to_tab(tab)
        self.wait(lambda: self.driver.read_terminal(tab).strip(), what="the prompt")
        self.run_command("exit")
        self.wait(lambda: self.terminal_session_exited(tab), what="the shell to exit")
        return tab

    def test_10_toast_clear_of_status_bar(self):
        with self.step(
            "toasts.placement.status-bar",
            "At 800x600 a toast starts above the status bar, never over its lock "
            "indicator (#5830)",
            expect="#5830 complaint: the 'Closed …' toast sits above the status bar; the "
            "status bar (lock indicator at its right end) is fully visible",
        ):
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                tab = self._exited_tab()
                self.close_tab(tab)
                toasts = self.wait(self._closed_toast, what="the 'Closed' toast", timeout=5.0)
                status = self._rect_of(STATUS_BAR)
                self.shot(label="status-bar")
                self.evidence(f"status bar {status}; toasts {[(t['text'], t['rect']) for t in toasts]}")
                problems = placement_problems(toasts, {"status bar": status})
                assert not problems, problems
            finally:
                self.driver.resize_window(*NORMAL_WINDOW)
        self.close_all_tabs()

    def test_20_toast_clear_of_editor_form(self):
        with self.step(
            "toasts.placement.editor-form",
            "At 800x600 a toast raised while the connection editor is open covers none of "
            "its fields, its footer or the status bar (#5830)",
            expect="#5830 complaint: with the connection editor open, the 'Closed …' toast "
            "is one compact line at the top right, above the form (over the editor title "
            "strip); no field, Save / Cancel or the status bar is covered",
        ):
            self.switch_to_connections_sidebar()
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                tab = self._exited_tab()
                self.open_new_connection_editor()
                self.close_tab(tab)
                time.sleep(0.5)  # let the stack re-lay out around the editor
                toasts = self.wait(self._closed_toast, what="the 'Closed' toast", timeout=5.0)
                keep_clear = {
                    "editor form": self._rect_of(EDITOR_FORM),
                    "editor footer": self._rect_of(EDITOR_FOOTER),
                    "status bar": self._rect_of(STATUS_BAR),
                }
                self.shot(label="editor-form")
                self.evidence(
                    f"keep-clear {keep_clear}; toasts {[(t['text'], t['rect']) for t in toasts]}"
                )
                problems = placement_problems(toasts, keep_clear)
                assert not problems, problems
            finally:
                self.driver.resize_window(*NORMAL_WINDOW)
        self.close_all_tabs()

    def test_30_dialog_dismisses_stale_toasts(self):
        with self.step(
            "toasts.placement.modal-open",
            "Opening a dialog dismisses the success toasts still showing, so old feedback "
            "never sits beside a new decision (#5830)",
            expect="#5830 complaint: after a tab was closed, its 'Closed … / Reopen' toast is "
            "gone as soon as the workflow editor opens, and does not come back after Cancel",
        ):
            # A workflow run raises no toast since #5859, so the stale toast is
            # the tab-close undo, which still toasts.
            self.switch_to_connections_sidebar()
            before = self.tab_ids()
            self.open_new_terminal()
            self.wait(lambda: len(self.tab_ids()) == len(before) + 1, what="a local terminal")
            self.close_tab(next(t for t in self.tab_ids() if t not in before))
            self.wait(
                lambda: any(i["text"].startswith("Closed") for i in self._toast_items()) or None,
                what="the 'Closed' toast",
            )
            self.show_automations()
            self.open_new_workflow()
            try:
                self.wait(
                    lambda: not stale_toast_problems(self._toast_items(), ["Closed"]),
                    what="the stale 'Closed' toast to go",
                    timeout=3.0,
                )
                dialog = self._rect_of(WORKFLOW_DIALOG)
                toasts = self._toast_items()
                self.shot(label="modal-open")
                self.evidence(f"dialog {dialog}; toasts {[(t['text'], t['rect']) for t in toasts]}")
                problems = placement_problems(toasts, {"dialog": dialog})
                assert not problems, problems
            finally:
                self.cancel_clean_editor()
            time.sleep(0.5)
            problems = stale_toast_problems(self._toast_items(), ["Closed"])
            assert not problems, f"after the editor closed: {problems}"
        self.close_all_tabs()
