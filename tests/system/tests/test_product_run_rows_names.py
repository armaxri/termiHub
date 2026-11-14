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

#5770 extends the grade to the other lists: a tunnel (its forwarding, SSH
connection and host), a service (its protocol, address and folder), a
workspace (its tab count) and a remote agent (its address), each with a
description. None of them is started or connected; the rows are graded at
rest.

#5789 adds the Network Tools monitor row (its name and description; the URL,
method and interval in the tooltip; the Stopped marker once stopped) and the
Plugins sidebar row of a seeded fixture plugin (its name and the plugin's own
description; version, author and id in the tooltip). The plugin is seeded
last: it restarts the app.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    AgentUi,
    ConnectionsUi,
    EmbeddedServicesUi,
    NetworkToolsUi,
    PasswordPromptUi,
    PluginsUi,
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


#: Save Current on the Workspaces toolbar (in its "…" menu when narrow, #4824).
WORKSPACE_SAVE_CURRENT = "workspace-save-current-btn"
WORKSPACE_OVERFLOW = "workspace-toolbar-overflow"
WORKSPACE_SAVE_DIALOG = "save-workspace-dialog"


class TestProductRunRowsNames(
    ProductRunUi,
    SshPhaseUi,
    AutomationPhaseUi,
    EmbeddedServicesUi,
    NetworkToolsUi,
    PluginsUi,
    AgentUi,
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
            self.create_local_connection(local, description="Scratch shell")
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
                self.ids["macro"], f"Rows schedule {t}", self.ids["conn"],
                description="Every minute check",
            )
            self.open_workflows_sidebar()

    # ── rows ─────────────────────────────────────────────────────────────────
    def test_10_connection_row(self):
        with self.step(
            "rows-names.connection",
            "A connection row shows its name and description: no host, user, port or type text",
            expect="the Connections sidebar: the 'pr-rows-local-…' row shows its icon, its "
            "name and 'Scratch shell' muted under it, nothing else (#5757)",
        ):
            self.require("rows-names.items")
            self.switch_to_connections_sidebar()
            row = f"connection-item-{self.ids['conn']}"
            text = self.row_text(row)
            self.evidence(f"connection row {text!r}")
            left = row_leftover_text(text, [self.ids["conn_name"], "Scratch shell"])
            assert left == "", f"the connection row shows more than its name: {left!r}"
            desc = self.driver.get_text(f"connection-description-{self.ids['conn']}").strip()
            assert desc == "Scratch shell", f"the connection description reads {desc!r}"
            self.switch_to_connections_sidebar()
            self.driver.type("connection-filter-input", "scratch")
            self.wait(lambda: self.driver.exists(row), what="the row found by its description")
            self.driver.type("connection-filter-input", "")
            self.shot(label="connection")

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
            expect="Settings -> Schedules: 'Rows schedule …' with a grey dot, 'Every minute "
            "check' muted under the name and 'Disabled'; no rule or 'on pr-rows-local-…' "
            "text on the row (#5757)",
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
                [f"Rows schedule {t}", "Every minute check", status],
                [f"on {self.ids['conn_name']}"],
            )
            self.shot(label="schedule")

    def test_50_tunnel_row(self):
        t = self.tag
        with self.step(
            "rows-names.tunnel",
            "A tunnel row shows its name and description; the forwarding, SSH connection and "
            "host are in the tooltip",
            expect="the Tunnels sidebar: 'Rows tunnel …' with a grey dot and 'Reaches the DB' "
            "muted under the name; no "
            "'Local' badge, no '127.0.0.1:…' mapping, no 'via …' and no 'this computer' on "
            "the row (#5770)",
        ):
            self.require("rows-names.items")
            ssh = f"pr-rows-ssh-{t}"
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                ssh, host="127.0.0.1", port=22, username="rows", connect=False
            )
            self.wait(lambda: self.find_connection(ssh) is not None, what="the SSH connection")
            name = f"Rows tunnel {t}"
            self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
            self.driver.click("tunnel-new-btn")
            self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")
            self.driver.type("tunnel-editor-name", name)
            self.driver.type("tunnel-editor-description", "Reaches the DB")
            self.wait(
                lambda: self._try_select("tunnel-editor-ssh-connection", ssh),
                what="the SSH connection option",
            )
            self.driver.click("tunnel-type-local")
            self.wait(
                lambda: self.driver.exists("tunnel-editor-local-port"), what="the port fields"
            )
            self.driver.type("tunnel-editor-local-port", "18577")
            self.driver.type("tunnel-editor-remote-host", "db.internal")
            self.driver.type("tunnel-editor-remote-port", "5432")
            self.driver.click("tunnel-editor-save")
            tunnel = self.wait(
                lambda: next(
                    (x for x in self.driver.get_state("tunnels") or [] if x.get("name") == name),
                    None,
                ),
                what="the tunnel to save",
            )
            self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
            self._grade_row(
                f"tunnel-item-{tunnel['id']}",
                [name, "Reaches the DB"],
                [
                    "Local · 127.0.0.1:18577 → db.internal:5432",
                    f"Via {ssh}",
                    "Hosted on this computer",
                ],
            )
            desc = self.driver.get_text(f"tunnel-description-{tunnel['id']}").strip()
            assert desc == "Reaches the DB", f"the tunnel description reads {desc!r}"
            self.shot(label="tunnel")

    def test_60_service_row(self):
        t = self.tag
        with self.step(
            "rows-names.service",
            "A service row shows its name and description; the protocol, address and folder "
            "are in the tooltip, and Run on is in the editor",
            expect="the Services sidebar: 'Rows service …' with a grey dot and 'Lab firmware' "
            "muted under the name; no "
            "'HTTP' badge, no ':port → folder' line and no 'Run on' selector on the row "
            "(#5770)",
        ):
            self.require("rows-names.items")
            name = f"Rows service {t}"
            port = self.free_port()
            server = self.create_server(
                name, proto="http", root="/tmp", port=port, description="Lab firmware"
            )
            row = f"server-item-{server['id']}"
            self.wait(lambda: self.driver.exists(row), what="the service row")
            self._grade_row(
                row, [name, "Lab firmware"], [f"HTTP · http://127.0.0.1:{port}", "Serves /tmp"]
            )
            assert not self.driver.exists(f"server-runloc-{server['id']}"), (
                "the Run on selector is still on the row"
            )
            self.shot(label="service")

    def test_70_workspace_row(self):
        t = self.tag
        with self.step(
            "rows-names.workspace",
            "A workspace row shows its name and description; the tab count is in the tooltip",
            expect="the Workspaces sidebar: 'Rows workspace …' with 'Morning layout' muted "
            "under it, nothing else (#5770)",
        ):
            self.require("rows-names.items")
            self.switch_to_connections_sidebar()
            self.connect_connection(self.ids["conn_name"])
            name = f"Rows workspace {t}"
            self._ensure_sidebar("workspaces", "activity-bar-workspaces")
            self.invoke_toolbar_action(WORKSPACE_SAVE_CURRENT, overflow=WORKSPACE_OVERFLOW)
            self.wait(
                lambda: self.driver.exists(WORKSPACE_SAVE_DIALOG), what="the save dialog"
            )
            self.driver.type("save-workspace-name", name)
            self.driver.type("save-workspace-description", "Morning layout")
            self.driver.click("save-workspace-confirm")
            ws = self.wait(
                lambda: next(
                    (
                        w
                        for w in self.driver.get_state("workspaces") or []
                        if w.get("name") == name
                    ),
                    None,
                ),
                what="the workspace to save",
            )
            self._grade_row(f"workspace-item-{ws['id']}", [name, "Morning layout"], ["Opens"])
            desc = self.driver.get_text(f"workspace-description-{ws['id']}").strip()
            assert desc == "Morning layout", f"the workspace description reads {desc!r}"
            self.shot(label="workspace")

    def test_80_agent_row(self):
        t = self.tag
        with self.step(
            "rows-names.agent",
            "A remote agent row shows its name, description, state dot and Connect; its "
            "address is in the tooltip",
            expect="the Connections sidebar, Remote Agents: 'Rows agent …' with a grey dot, "
            "its name, Connect and 'Lab bench' muted under it; no 'rows@127.0.0.1:22' and no "
            "version on the row (#5770)",
        ):
            self.require("rows-names.items")
            name = f"Rows agent {t}"
            agent = self.create_remote_agent(
                name, host="127.0.0.1", port=22, username="rows", description="Lab bench"
            )
            header = self.agent_header_testid(agent["id"])
            self.wait(lambda: self.driver.exists(header), what="the agent header")
            text = self.row_text(header)
            tip = self.driver.get_attribute(header, "title") or ""
            self.evidence(f"agent header {text!r}; tooltip {tip!r}")
            left = row_leftover_text(text, [name, "Connect", "Lab bench"])
            assert left == "", f"the agent row shows settings text: {left!r}"
            assert "rows@127.0.0.1:22" in tip, f"the address is not in the tooltip {tip!r}"
            desc = self.driver.get_text(f"agent-description-{agent['id']}").strip()
            assert desc == "Lab bench", f"the agent description reads {desc!r}"
            self.shot(label="agent")

    def test_90_monitor_row(self):
        t = self.tag
        with self.step(
            "rows-names.monitor",
            "A monitor row shows its name, description and Stopped marker; the URL, method "
            "and interval are in the tooltip",
            expect="the Network Tools sidebar: 'Rows monitor …' with a grey dot, 'Shop health' "
            "muted under it and 'Stopped'; no '127.0.0.1:…' URL, no status code, latency or "
            "'checked … ago' on the row (#5789)",
        ):
            self.require("rows-names.items")
            name = f"Rows monitor {t}"
            url = f"http://127.0.0.1:{self.free_port()}/health"
            self.start_http_monitor(
                url, allow_private_network=True, name=name, description="Shop health"
            )
            self.wait(lambda: self.driver.exists("http-monitor-stop"), what="the monitor to start")
            self.stop_http_monitor()
            self.open_network_tools_sidebar()
            monitor = self.wait(
                lambda: next(
                    (
                        m
                        for m in self.driver.get_state("httpMonitors") or []
                        if (m.get("config") or {}).get("name") == name and not m.get("running")
                    ),
                    None,
                ),
                what="the stopped monitor in the store",
            )
            mid = monitor["config"]["id"]
            row = f"monitor-row-{mid}"
            self.wait(
                lambda: self.driver.exists(f"monitor-marker-{mid}"), what="the Stopped marker"
            )
            marker = self.driver.get_text(f"monitor-marker-{mid}").strip()
            assert marker == "Stopped", f"the marker reads {marker!r}"
            self._grade_row(
                row, [name, "Shop health", marker], [url, "GET every 30s · expects 200"]
            )
            desc = self.driver.get_text(f"monitor-description-{mid}").strip()
            assert desc == "Shop health", f"the monitor description reads {desc!r}"
            self.shot(label="monitor")

    def test_95_plugin_row(self):
        with self.step(
            "rows-names.plugin",
            "A plugin row shows its name and the plugin's own description; its version, "
            "author and id are in the tooltip",
            expect="the Plugins sidebar: 'Sandbox Probe' with its 'Fixture plugin: …' "
            "description muted under it; no 'v1.0.0' on the row (#5789)",
        ):
            self.require("rows-names.items")
            self.seed_sandbox_plugin()
            self.wait(
                lambda: self.sandbox_plugin_state() is not None, what="the seeded plugin"
            )
            self._ensure_sidebar("plugins", "activity-bar-plugins")
            pid = self.SANDBOX_PLUGIN_ID
            row = f"plugin-row-{pid}"
            self.wait(lambda: self.driver.exists(row), what="the plugin row")
            allowed = ["Sandbox Probe", self.driver.get_text(f"plugin-description-{pid}").strip()]
            if self.driver.exists(f"plugin-marker-{pid}"):
                allowed.append(self.driver.get_text(f"plugin-marker-{pid}").strip())
            self._grade_row(
                row, allowed, ["Version 1.0.0", "By termiHub system tests", f"ID {pid}"]
            )
            assert allowed[1].startswith("Fixture plugin"), f"the description reads {allowed[1]!r}"
            self.shot(label="plugin")
