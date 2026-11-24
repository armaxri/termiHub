"""Product run: toasts at the minimum window beside a tall dialog (#5715).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Follow-up to #5686: the toast stack lifts above an open
dialog or narrows to a column (at least 240px) beside it, but at the 800x600
minimum window a ``lg`` dialog leaves room for neither, and the stack still
covered the dialog's edge.

Now the stack docks at the top edge in its compact form: errors stay visible
as one line over the dialog head, while success/info toasts wait until the
dialog closes. The grade runs a workflow, shrinks the window to 800x600, opens
the workflow editor and checks no toast covers the dialog. Since #5859 a run in
the visible terminal raises no "Ran workflow" toast at all (the output and the
run history show it), and none may appear beside the dialog or after the
editor closes. No sshd: a local shell is enough.
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
    unique_name,
)
from termihub_harness.product_run import ProductRunUi

pytestmark = [pytest.mark.product_run, pytest.mark.integration]

TOAST_REGION = "toast-region"
WORKFLOW_DIALOG = "workflow-editor-dialog"
#: The minimum supported window, where a ``lg`` dialog leaves no 240px column.
NARROW_WINDOW = (800, 600)
#: The product run's normal window, restored afterwards.
NORMAL_WINDOW = (1280, 800)
EPS = 0.5


def _shown(item: dict[str, Any]) -> bool:
    """Rendered and bigger than a screen-reader-only 1 px box."""
    return bool(item["visible"]) and item["rect"]["width"] > 2 and item["rect"]["height"] > 2


def _intersects(a: dict[str, float], b: dict[str, float]) -> bool:
    """The two viewport boxes overlap by more than the rounding slack."""
    return (
        a["x"] < b["x"] + b["width"] - EPS
        and b["x"] < a["x"] + a["width"] - EPS
        and a["y"] < b["y"] + b["height"] - EPS
        and b["y"] < a["y"] + a["height"] - EPS
    )


class TestProductRunToastNarrow(
    ProductRunUi,
    WorkflowUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Toasts at the minimum window"
    request_timeout = 90.0

    def reset_before_rerun(self) -> None:
        self.driver.resize_window(*NORMAL_WINDOW)

    def _toast_items(self) -> list[dict[str, Any]]:
        """The visible text and button boxes inside the toast stack."""
        if not self.driver.exists(TOAST_REGION):
            return []
        items = []
        for kind in ("text", "buttons"):
            items += [i for i in self.driver.measure_element(TOAST_REGION, kind)["items"] if _shown(i)]
        return items

    def _ran_toasts(self) -> list[dict[str, Any]]:
        return [i for i in self._toast_items() if i["text"].startswith("Ran workflow")]

    def _create_workflow(self, name: str, command: str) -> str:
        self.show_automations()
        self.open_new_workflow()
        self.add_step("send-command")
        self.set_command(0, command)
        self.set_name(name)
        self.save_workflow()
        return self.workflow_id(name)

    def test_10_toast_clear_of_tall_dialog_at_minimum_window(self):
        tag = unique_name("pr").split("-")[-1]
        with self.step(
            "complaints.toasts.dialog-narrow",
            "At 800x600 a toast never covers the open workflow editor, and no run success "
            "toast shows at all (#5715, #5830, #5859)",
            expect="#5715/#5830 complaint: in an 800x600 window with the workflow editor open, "
            "no toast sits on the dialog (errors would dock as one line at the top edge); the "
            "run raised no 'Ran workflow' toast, before or after Cancel",
        ):
            workflow = self._create_workflow(f"Toast narrow {tag}", f"echo PR_TOAST_NARROW_{tag}")
            self.ensure_terminal()
            self.show_automations()
            self.driver.resize_window(*NARROW_WINDOW)
            try:
                self.run_workflow(workflow)
                self.wait_for_output(f"PR_TOAST_NARROW_{tag}")
                self.open_new_workflow()
                try:
                    time.sleep(0.5)  # let the stack re-lay out around the dialog
                    dialog = self.driver.measure_element(WORKFLOW_DIALOG)["rect"]
                    toasts = self._toast_items()
                    self.shot(label="narrow-dialog")
                    self.evidence(
                        f"window {NARROW_WINDOW}; dialog {dialog}; toasts "
                        f"{[(t['text'], t['rect']) for t in toasts]}"
                    )
                    for item in toasts:
                        assert not _intersects(item["rect"], dialog), (
                            f"toast {item['text'] or item['label']!r} {item['rect']} covers "
                            f"the open dialog {dialog}"
                        )
                    assert not self._ran_toasts(), (
                        "a 'Ran workflow' success toast shows beside the dialog; a run in the "
                        "visible terminal raises none (#5859)"
                    )
                finally:
                    self.cancel_clean_editor()
                time.sleep(0.5)
                assert not self._ran_toasts(), (
                    "a 'Ran workflow' toast showed after the editor closed"
                )
            finally:
                self.driver.resize_window(*NORMAL_WINDOW)
        self.close_all_tabs()
