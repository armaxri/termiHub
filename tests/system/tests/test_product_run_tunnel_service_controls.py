"""Product run: tunnel and service rows show Start / Stop and a labelled dot (#5852).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). The UI review of run
``20261123T215628Z`` (R-046) found tunnel and service rows with only a name, a
muted description and a grey dot: the Start / Stop control appeared on hover
only and the dot did not say what it meant. Each row now keeps its run control
visible at rest on the trailing edge, like a macro's Play, and its dot names
its state (Stopped, Running, Error) in a tooltip and as its accessible name.
The other actions (Edit, Duplicate, Delete, …) still appear on hover.

One fresh profile: an SSH connection that is never connected, a tunnel on it
saved without starting, and an HTTP service that is started and stopped from
its row.

The ``test_grade_*`` functions grade fixed inputs without an app and run in the
normal lane.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    ConnectionsUi,
    EmbeddedServicesUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.row_controls import PRIMARY_ACTION_CLASS, row_control_problems

ROW = f"sidebar-list-item {PRIMARY_ACTION_CLASS} sidebar-list-item--actions-visible"


# ── app-free grade tests ──────────────────────────────────────────────────
def _grade(kind: str, dot: str, controls: list[str], row_class: str = ROW, title=None):
    return row_control_problems(
        kind,
        "row",
        dot_label=dot,
        dot_title=dot if title is None else title,
        primary_labels=controls,
        row_class=row_class,
    )


def test_grade_stopped_tunnel_with_start_passes():
    assert _grade("tunnel", "Stopped", ["Start"]) == []
    assert _grade("tunnel", "Running", ["Stop"]) == []
    assert _grade("tunnel", "Error", ["Retry"]) == []


def test_grade_service_states_pass():
    assert _grade("server", "Stopped", ["Start"]) == []
    assert _grade("server", "Running", ["Stop"]) == []
    assert _grade("server", "Error", ["Start"]) == []


def test_grade_hover_only_control_fails():
    problems = _grade("tunnel", "Stopped", ["Start"], row_class="sidebar-list-item")
    assert problems == ["row: the run control is hover-only, not visible at rest"]


def test_grade_missing_control_fails():
    problems = _grade("server", "Stopped", [])
    assert problems == ["row: expected one run control on the row, found []"]


def test_grade_wrong_control_for_state_fails():
    problems = _grade("tunnel", "Running", ["Start"])
    assert problems == ["row: a 'Running' row offers 'Start', not 'Stop'"]


def test_grade_unlabelled_dot_fails():
    problems = row_control_problems(
        "tunnel",
        "row",
        dot_label=None,
        dot_title=None,
        primary_labels=["Start"],
        row_class=ROW,
    )
    assert problems == ["row: the status dot has no accessible name"]


def test_grade_connection_words_on_a_tunnel_dot_fail():
    problems = _grade("tunnel", "Disconnected", ["Start"])
    assert problems == ["row: the status dot reads 'Disconnected', not a known state"]


def test_grade_dot_without_tooltip_fails():
    problems = _grade("server", "Running", ["Stop"], title="")
    assert problems == ["row: the dot's tooltip '' differs from 'Running'"]


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="uses POSIX paths")
class TestProductRunTunnelServiceControls(
    ProductRunUi, EmbeddedServicesUi, SidebarUi, ConnectionsUi, SystemTest
):
    phase = "Tunnel and service run controls"
    request_timeout = 90.0

    tag = unique_name("pr").split("-")[-1]
    ids: dict[str, str] = {}

    def _grade_row(self, kind: str, item_id: str) -> str:
        """Grade one row at rest; return its dot label."""
        self.driver.force_hover(None)
        dot = f"{kind}-status-{item_id}"
        primary = f"{kind}-primary-{item_id}"
        label = self.driver.get_attribute(dot, "aria-label")
        title = self.driver.get_attribute(dot, "title")
        buttons = (
            self.driver.measure_element(primary, "buttons").get("items", [])
            if self.driver.exists(primary)
            else []
        )
        controls = [b.get("label") for b in buttons if b.get("visible")]
        row_class = self.driver.get_attribute(f"{kind}-item-{item_id}", "class")
        self.evidence(f"{kind} {item_id}: dot {label!r} (title {title!r}); controls {controls}")
        problems = row_control_problems(
            kind,
            f"{kind} row",
            dot_label=label,
            dot_title=title,
            primary_labels=controls,
            row_class=row_class,
        )
        assert not problems, problems
        return label or ""

    def test_10_tunnel_row(self):
        t = self.tag
        with self.step(
            "row-controls.tunnel",
            "A stopped tunnel row shows a Start button at rest and a dot that says Stopped",
            expect="the SSH tunnels sidebar: 'Controls tunnel …' with a grey dot, its name, and "
            "a Play (Start) button on the right without hovering; hovering the dot shows "
            "'Stopped' (#5852)",
        ):
            ssh = f"pr-ctl-ssh-{t}"
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                ssh, host="127.0.0.1", port=22, username="controls", connect=False
            )
            self.wait(lambda: self.find_connection(ssh) is not None, what="the SSH connection")
            name = f"Controls tunnel {t}"
            self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
            self.driver.click("tunnel-new-btn")
            self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")
            self.driver.type("tunnel-editor-name", name)
            self.wait(
                lambda: self._try_select("tunnel-editor-ssh-connection", ssh),
                what="the SSH connection option",
            )
            self.driver.click("tunnel-type-local")
            self.wait(
                lambda: self.driver.exists("tunnel-editor-local-port"), what="the port fields"
            )
            self.driver.type("tunnel-editor-local-port", str(self.free_port()))
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
            self.ids["tunnel"] = tunnel["id"]
            self._ensure_sidebar("tunnels", "activity-bar-ssh-tunnels")
            row = f"tunnel-item-{tunnel['id']}"
            self.wait(lambda: self.driver.exists(row), what="the tunnel row")
            assert self._grade_row("tunnel", tunnel["id"]) == "Stopped"
            self.shot(label="tunnel")

    def test_20_service_row_start_stop(self):
        t = self.tag
        with self.step(
            "row-controls.service",
            "A service row starts and stops from its always-visible button; the dot says "
            "Stopped, then Running",
            expect="the Services sidebar: 'Controls service …' with a green dot and a Stop "
            "(square) button on the right without hovering; hovering the dot shows 'Running' "
            "(#5852)",
        ):
            name = f"Controls service {t}"
            server = self.create_server(name, proto="http", root="/tmp", port=self.free_port())
            sid = server["id"]
            self.ids["server"] = sid
            self.wait(lambda: self.driver.exists(f"server-item-{sid}"), what="the service row")
            assert self._grade_row("server", sid) == "Stopped"
            self.start_server(sid)
            self.wait(
                lambda: self.driver.get_attribute(f"server-status-{sid}", "aria-label")
                == "Running",
                what="the dot to read Running",
            )
            assert self._grade_row("server", sid) == "Running"
            self.shot(label="service-running")
            self.stop_server(sid)
            self.wait(
                lambda: self.driver.get_attribute(f"server-status-{sid}", "aria-label")
                == "Stopped",
                what="the dot to read Stopped",
            )
            assert self._grade_row("server", sid) == "Stopped"
