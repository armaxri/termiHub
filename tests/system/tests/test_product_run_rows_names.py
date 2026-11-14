"""Product run: list rows show names, not settings (#5757).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The maintainer's rule (docs/copy-style.md -> "List rows:
names, not settings"): a sidebar or list row shows the name the user gave the
item, its short description when one is set, and only state markers that need
attention. Configuration and history (trigger, target, step previews, the last
run, tags) are in the row's tooltip, which is also the row's accessible
description.

One fresh profile with a saved local-shell connection, a macro with a
description and tags, an on-output-match workflow with a description and
tags, and a schedule left off. Each row's visible text must be its name,
description and markers only; the settings must be in its tooltip.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    WorkflowUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.automation_steps import MACRO_EDITOR, AutomationPhaseUi
from termihub_harness.product_run.grades import row_leftover_text
from termihub_harness.product_run.ssh_steps import SshPhaseUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX shell quoting"),
]


class TestProductRunRowsNames(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    WorkflowUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Rows show names"
    request_timeout = 90.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def _grade_row(self, row: str, allowed: list[str], settings: list[str]) -> None:
        """The row shows only ``allowed`` text; each of ``settings`` is in its tooltip."""
        text = self.row_text(row)
        tip = self.row_tooltip(row)
        self.evidence(f"{row}: row {text!r}; tooltip {tip!r}")
        left = row_leftover_text(text, allowed)
        assert left == "", f"{row} shows settings text on the row: {left!r}"
        for setting in settings:
            assert setting not in text, f"{row}: {setting!r} is on the row"
            assert setting in tip, f"{row}: {setting!r} is not in the tooltip {tip!r}"

    # ── fixtures ─────────────────────────────────────────────────────────────
    def test_00_items(self):
        t = self.tag
        with self.step(
            "rows-names.items",
            "A saved connection, a macro, a triggered workflow and a schedule, each named",
            expect="the Workflows sidebar listing 'Answer rows' (description 'Replies on "
            "match'), with an Armed marker",
        ):
            self.enable_experimental_features()
            local = f"pr-rows-local-{t}"
            self.switch_to_connections_sidebar()
            self.create_local_connection(local)
            self.ids["conn_name"] = local
            self.ids["conn"] = self.require_connection(local)["id"]

            self.ids["macro"] = self.create_macro(
                f"Rows macro {t}", [f"echo PR_ROWS_MACRO_{t}\\r"]
            )
            self.driver.click(f"macro-edit-{self.ids['macro']}")
            self.wait(lambda: self.driver.exists(MACRO_EDITOR), what="the macro editor")
            self.driver.type("macro-editor-description", "Checks the release")
            self.driver.type("macro-editor-tags", "ops")
            self._save_macro()
            self.wait(
                lambda: (self.macro(self.ids["macro"]) or {}).get("description")
                == "Checks the release",
                what="the macro description to save",
            )

            self.author_workflow(f"Answer rows {t}", [
                ("send-command", {"step-command": f"echo PR_ROWS_ANSWER_{t}"}),
            ])
            self.driver.type("workflow-editor-description", "Replies on match")
            self.driver.type("workflow-editor-tags", "deploy")
            self.set_output_match_trigger(self.ids["conn"], f"PR_ROWS_FIRE_{t}")
            self.save_workflow()
            self.ids["workflow"] = self.workflow_id(f"Answer rows {t}")

            self.ids["schedule"] = self.schedule_macro(
                self.ids["macro"], f"Rows schedule {t}", self.ids["conn"]
            )
            self.open_workflows_sidebar()

    # ── rows ─────────────────────────────────────────────────────────────────
    def test_10_connection_row(self):
        with self.step(
            "rows-names.connection",
            "A connection row shows its name only: no host, user, port or type text",
            expect="the Connections sidebar: the 'pr-rows-local-…' row shows its icon and "
            "name, nothing else (#5757)",
        ):
            self.require("rows-names.items")
            self.switch_to_connections_sidebar()
            row = f"connection-item-{self.ids['conn']}"
            text = self.row_text(row)
            self.evidence(f"connection row {text!r}")
            left = row_leftover_text(text, [self.ids["conn_name"]])
            assert left == "", f"the connection row shows more than its name: {left!r}"

    def test_20_macro_row(self):
        t = self.tag
        with self.step(
            "rows-names.macro",
            "A macro row shows its name and description; what it types and its tags are in "
            "the tooltip",
            expect="the Macros sidebar: 'Rows macro …' with 'Checks the release' muted under "
            "it and the Play button; no 'echo …' preview and no tag chips on the row (#5757)",
        ):
            self.require("rows-names.items")
            self.show_macros()
            mid = self.ids["macro"]
            self._grade_row(
                f"macro-item-{mid}",
                [f"Rows macro {t}", "Checks the release"],
                [f"echo PR_ROWS_MACRO_{t}", "Tags: ops"],
            )
            assert self.driver.exists(f"macro-description-{mid}"), "no description line"
            self.shot(label="macro")

    def test_30_workflow_row(self):
        t = self.tag
        with self.step(
            "rows-names.workflow",
            "A workflow row shows its name, description and Armed marker; the trigger, its "
            "target and the tags are in the tooltip",
            expect="the Workflows sidebar: 'Answer rows …' with 'Replies on match' muted under "
            "it and an 'Armed' marker with its switch; no 'On output match' text and no tag "
            "chips on the row (#5757)",
        ):
            self.require("rows-names.items")
            self.open_workflows_sidebar()
            wid = self.ids["workflow"]
            marker = self.driver.get_text(f"workflow-armed-{wid}").strip()
            assert marker == "Armed", f"the marker reads {marker!r}"
            self._grade_row(
                f"workflow-item-{wid}",
                [f"Answer rows {t}", "Replies on match", marker],
                ["On output match", self.ids["conn_name"], "Tags: deploy"],
            )
            self.shot(label="workflow")

    def test_40_schedule_row(self):
        t = self.tag
        with self.step(
            "rows-names.schedule",
            "A schedule row shows its name and the Disabled marker; the rule and targets are "
            "in the tooltip",
            expect="Settings -> Schedules: 'Rows schedule …' with a grey dot and 'Disabled' "
            "under the name; no 'Every …' rule or 'on pr-rows-local-…' text on the row (#5757)",
        ):
            self.require("rows-names.items")
            self.open_settings_category("schedules")
            sid = self.ids["schedule"]
            row = f"schedule-item-{sid}"
            self.wait(lambda: self.driver.exists(row), what="the schedule row")
            status = self.driver.get_text(f"schedule-status-{sid}").strip()
            assert status == "Disabled", f"the state marker reads {status!r}"
            self._grade_row(
                row,
                [f"Rows schedule {t}", status],
                [f"on {self.ids['conn_name']}", "Every"],
            )
            self.shot(label="schedule")
