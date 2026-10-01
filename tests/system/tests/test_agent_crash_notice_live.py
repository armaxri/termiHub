"""Live "agent crashed since last connect" notice (#3593, OBS-010; automated in #4009).

The Rust suites cover the pieces: the agent's ``agent.crash_reports.list`` /
``read`` handlers (``agent/src/handler/dispatch/tests/crash_reports_tests.rs``),
the baseline / notify / acknowledge rules of the desktop's seen-store
(``src-tauri/src/utils/agent_crash_notice_tests.rs``) and the redacted read
(``agent_crash_reports_tests.rs``). This suite drives the whole chain against the
deployed-agent container (``remote_agent_fixtures``, the same one
``test_remote_agent_live.py`` uses):

1. The first connect of a new agent records the host's current reports as the
   baseline and shows nothing.
2. A crash report written on the host afterwards raises the notice on the next
   connect. **View Report** shows it redacted again on the desktop, and acting on
   it records it as seen, so a further reconnect stays quiet.
3. With the shared ``showCrashReportNotice`` opt-out the desktop does not check at
   all, so the crash is not consumed: turning the notice back on and reconnecting
   shows it.

Reports are seeded as the agent's own user into its
``~/.config/termihub-agent/logs/crash-reports/`` and removed again afterwards, so
other suites sharing the container never see them.
"""

from __future__ import annotations

from typing import Iterator

import pytest

from termihub_harness import (
    REMOTE_AGENT_PORT,
    REMOTE_AGENT_SERVICE,
    SSH_HOST,
    SSH_PASSWORD,
    SSH_USERNAME,
    AgentUi,
    ContainerRuntimeUnavailable,
    CrashReportUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SshServerControl,
    SystemTest,
    TabsUi,
    unique_name,
)
from termihub_harness.ui.diagnostics import (
    AGENT_CRASH_DIR,
    agent_crash_notice_testid,
    crash_report_names,
    crash_report_text,
)

pytestmark = pytest.mark.integration

#: Secret / identity shapes the desktop's redactor masks (``core::diagnostics::redact``).
SECRETS = "password=hunter2-4009 addr 10.20.30.40"


@pytest.mark.usefixtures("remote_agent_fixtures")
class TestAgentCrashNoticeLive(
    AgentUi,
    CrashReportUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    SystemTest,
):
    """One app for the suite; each test creates its own agent and reports."""

    @pytest.fixture(autouse=True)
    def _agent_host(self) -> Iterator[None]:
        """Exec access to the agent host; removes every report a test seeded."""
        self.host = SshServerControl(REMOTE_AGENT_SERVICE)
        if not self.host.available:
            pytest.skip("no container runtime to seed agent crash reports")
        self.seeded: list[str] = []
        yield
        for name in self.seeded:
            try:
                self.host.remove_path(f"{AGENT_CRASH_DIR}/{name}")
            except ContainerRuntimeUnavailable:
                pass
        if not self.crash_notice_setting():
            self.set_crash_notice_enabled(True)
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── helpers ──────────────────────────────────────────────────────────────
    def _seed_agent_report(self, name: str, text: str) -> None:
        self.seeded.append(name)
        self.host.write_file(f"{AGENT_CRASH_DIR}/{name}", text, user=SSH_USERNAME)

    def _connect(self, name: str) -> None:
        self.connect_agent(name)
        self.handle_password_prompt(SSH_PASSWORD)
        self.wait_agent_connected(name)

    def _set_notice(self, enabled: bool) -> None:
        self.set_crash_notice_enabled(enabled)
        self.switch_to_connections_sidebar()

    def _reconnect(self, name: str) -> None:
        self.disconnect_agent(name)
        self.wait(
            lambda: self.agent_connection_state(name) == "disconnected",
            what=f"agent {name!r} to disconnect",
        )
        self._connect(name)

    def _create_and_baseline(self, label: str) -> dict:
        """Create + connect a fresh agent and wait for its baseline check."""
        agent = self.create_remote_agent(
            unique_name(label), host=SSH_HOST, port=REMOTE_AGENT_PORT, username=SSH_USERNAME
        )
        self._connect(agent["name"])
        self.wait(
            lambda: self.agent_seen_entry(agent["id"]) is not None,
            what="the first connect to record the agent's crash-report baseline",
        )
        assert not self.driver.exists(agent_crash_notice_testid(agent["id"])), (
            "the baseline check must not raise a notice for reports that predate it"
        )
        return agent

    # ── tests ────────────────────────────────────────────────────────────────
    def test_a_crash_after_the_baseline_is_announced_once_and_viewed_redacted(self):
        agent = self._create_and_baseline("agent-crash-notice")
        agent_id, notice = agent["id"], agent_crash_notice_testid(agent["id"])

        marker = unique_name("agent-crash")
        (name,) = crash_report_names(1, pid=3593)
        self._seed_agent_report(name, crash_report_text(marker, secrets=SECRETS))

        self._reconnect(agent["name"])
        self.wait_notice_visible(notice)

        text = self.view_crash_report(agent_crash_notice_testid(agent_id, "view"))
        assert f"seeded crash {marker}" in text, text
        # Redacted again on this computer before it is shown.
        assert "hunter2-4009" not in text, text
        assert "10.20.30.40" not in text, text
        assert "[REDACTED]" in text and "[ip]" in text, text
        self.close_crash_report_viewer()

        # Viewing acknowledged it: the notice is gone and the report is seen.
        assert not self.driver.exists(notice)
        self.wait(
            lambda: (self.agent_seen_entry(agent_id) or {}).get("newestSeen") == name,
            what="the viewed report to be recorded as seen",
        )

        # Nothing new since: the next connect stays quiet.
        self._reconnect(agent["name"])
        self.assert_notice_stays_hidden(notice)
        assert (self.agent_seen_entry(agent_id) or {}).get("newestSeen") == name

    def test_the_opt_out_skips_the_check_without_consuming_the_crash(self):
        agent = self._create_and_baseline("agent-crash-optout")
        agent_id, notice = agent["id"], agent_crash_notice_testid(agent["id"])
        baseline = self.agent_seen_entry(agent_id)

        self._set_notice(False)
        (name,) = crash_report_names(1, pid=3594)
        self._seed_agent_report(name, crash_report_text(unique_name("agent-optout")))

        self._reconnect(agent["name"])
        self.assert_notice_stays_hidden(notice)
        assert self.agent_seen_entry(agent_id) == baseline, (
            "an opted-out connect must not check the agent or move its seen cursor"
        )

        # Back on: the next connect checks again and the crash is still new.
        self._set_notice(True)
        self._reconnect(agent["name"])
        self.wait_notice_visible(notice)
        self.driver.click(agent_crash_notice_testid(agent_id, "dismiss"))
        self.wait(lambda: not self.driver.exists(notice), what="the agent notice to close")
        self.wait(
            lambda: (self.agent_seen_entry(agent_id) or {}).get("newestSeen") == name,
            what="the dismissed report to be recorded as seen",
        )
