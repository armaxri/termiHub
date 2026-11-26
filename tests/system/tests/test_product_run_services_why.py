"""Product run: a tunnel says why it does not start, and Retry works (#6028, slice 10).

The live grade is hand-triggered only (``scripts/internal/product-run.sh``;
deselected without ``--product-run``). A local tunnel goes through the run's
bastion sshd. The bastion is stopped: Start fails and the row says that the
server refused the connection, with "Edit connection" beside it; the tunnel's
Activity marks the SSH server as the part of the path that fails. The bastion
is started again and Retry brings the tunnel up.

The ``test_grade_*`` functions grade fixed observations without an app and run
in the normal lane.
"""

from __future__ import annotations

import sys
from typing import Any

import pytest

from termihub_harness import (
    ConnectionsUi,
    EmbeddedServicesUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)
from termihub_harness.fixtures import SSH_HOST
from termihub_harness.native_ssh import NativeBastionControl
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi

REFUSED = "refused the connection. Is its SSH server running?"


def why_problems(*, reason: str, steps: list[str], failing: str | None, after_retry: str) -> list[str]:
    """What is wrong with what the row said while the server was down, and after Retry."""
    problems: list[str] = []
    if REFUSED not in reason:
        problems.append(f"the row does not say who refused: {reason!r}")
    if "editConnection" not in steps:
        problems.append(f"no 'Edit connection' beside the reason: {steps}")
    if failing != "server":
        problems.append(f"Activity marks {failing!r} as failing, not the SSH server")
    if after_retry != "connected":
        problems.append(f"Retry left the tunnel {after_retry!r}")
    return problems


# ── app-free grade tests ──────────────────────────────────────────────────
def test_grade_told_and_retried_passes():
    reason = f"Bastion {REFUSED}"
    assert why_problems(
        reason=reason, steps=["editConnection"], failing="server", after_retry="connected"
    ) == []


def test_grade_a_bare_error_fails():
    problems = why_problems(
        reason="SSH error: Connection failed", steps=[], failing=None, after_retry="error"
    )
    assert len(problems) == 4, problems


# ── live grade ────────────────────────────────────────────────────────────
@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunServicesWhy(
    ProductRunUi,
    SshPhaseUi,
    EmbeddedServicesUi,
    TabsUi,
    SettingsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "Services say why"
    request_timeout = 90.0
    state: dict[str, Any] = {}

    def _status(self, tunnel_id: str) -> str | None:
        states = self.driver.get_state("tunnelStates") or {}
        return (states.get(tunnel_id) or {}).get("status")

    #: The row's next steps and their test ids, without the service id.
    STEPS = {
        "editConnection": "tunnel-edit-connection",
        "openTerminal": "tunnel-open-terminal",
        "reviewKey": "tunnel-review-key",
        "edit": "tunnel-edit-port",
    }

    def _steps(self, tunnel_id: str) -> list[str]:
        return [s for s, tid in self.STEPS.items() if self.driver.exists(f"{tid}-{tunnel_id}")]

    def test_10_server_down_then_retry(self):
        with self.step(
            "services.why",
            "A tunnel whose SSH server is down says who refused, with 'Edit connection'; "
            "its Activity marks the SSH server; once the server is back, Retry starts it "
            "(#6028 slice 10)",
            expect="the row 'Error' with '<bastion> refused the connection. Is its SSH "
            "server running? Edit connection'; Activity's path with 'Fails here' on the "
            "SSH server; after Retry the row 'Running' with its address",
        ):
            native = self.need_native()
            port = native.target.jump_port
            if not port:
                raise pytest.skip.Exception("the run's fixture started no bastion")
            bastion = NativeBastionControl(native.target)
            connection = unique_name("pr-why-bastion")
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                connection, host=SSH_HOST, port=port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=False,
            )
            self.wait(lambda: self.find_connection(connection), what="the connection")
            name = unique_name("pr-why-tunnel")
            self.choose_new_service("tunnel-local")
            self.wait(lambda: self.driver.exists("tunnel-editor-name"), what="the tunnel editor")
            self.driver.type("tunnel-editor-name", name)
            self.driver.select("tunnel-editor-ssh-connection", connection)
            self.driver.type("tunnel-editor-remote-host", "127.0.0.1")
            self.driver.type("tunnel-editor-remote-port", str(native.target.port))
            self.driver.type("tunnel-editor-local-port", str(self.free_port()))
            self.driver.click("tunnel-editor-save")
            tunnel = self.wait(
                lambda: next(
                    (t for t in self.driver.get_state("tunnels") or [] if t.get("name") == name),
                    None,
                ),
                what="the tunnel",
            )
            tid = tunnel["id"]
            try:
                bastion.stop()
                self.driver.click(f"tunnel-start-{tid}")
                self.wait(lambda: self._status(tid) == "error" or None, timeout=60.0,
                          what="the start to fail")
                reason = self.driver.get_text(f"tunnel-reason-{tid}").strip()
                steps = self._steps(tid)
                self.shot(label="server-down")
                self.driver.context_menu(f"tunnel-item-{tid}")
                self.wait(lambda: self.driver.exists(f"tunnel-ctx-activity-{tid}"),
                          what="the tunnel's menu")
                self.driver.click(f"tunnel-ctx-activity-{tid}")
                self.wait(lambda: self.driver.exists("service-activity"), what="Activity")
                failing = None
                if self.driver.exists("tunnel-diagram-fails"):
                    text = self.driver.get_text("tunnel-diagram")
                    failing = "server" if "SSH SERVER" in text.upper() else "other"
                self.shot(label="activity")
            finally:
                bastion.restore()
            self.driver.click("service-activity-action-retry")
            self.accept_all_hostkeys(timeout=15.0)
            after = self.wait(lambda: self._status(tid) if self._status(tid) in
                              ("connected", "error") else None, timeout=60.0,
                              what="the retry to finish")
            self.shot(label="after-retry")
            self.evidence(f"reason {reason!r}; steps {steps}; failing {failing}; after {after}")
            problems = why_problems(reason=reason, steps=steps, failing=failing, after_retry=after)
            assert not problems, problems
        self.close_all_tabs()
