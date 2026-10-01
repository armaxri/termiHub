"""Crash-report notice helpers (OBS-010, #3571 / #3593; automated in #4009).

``CrashReportUi`` seeds crash reports where the app and a remote agent look for
them, and drives the two non-blocking notices plus the shared report viewer:

* **Local** (#3571): the app reads ``<log dir>/crash-reports/crash-*.txt`` at
  start. The harness points the log dir at ``<config dir>/logs``
  (``TERMIHUB_LOG_DIR``), so a test seeds a report there while the app is down
  (a :meth:`~termihub_harness.SystemTest.restart_app` ``between`` hook).
* **Agent** (#3593): after a connect, the desktop lists the agent's reports and
  remembers the newest one per agent in ``agent-crash-reports-seen.json`` in its
  config dir. The test seeds a report on the agent host (see
  :meth:`~termihub_harness.SshServerControl.write_file`).

Report names are ``crash-YYYYMMDDTHHMMSSZ-<pid>.txt`` and sort by time; both
notices key off that order, so :func:`crash_report_name` builds them.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from .base import HarnessMixin

if TYPE_CHECKING:
    from ..orchestrator import AppInstance

#: Local crash notice and its actions (``CrashReportNotice.tsx``).
CRASH_NOTICE = "crash-report-notice"
CRASH_NOTICE_VIEW = "crash-report-notice-view"
CRASH_NOTICE_NEVER = "crash-report-notice-never"
CRASH_NOTICE_DISMISS = "crash-report-notice-dismiss"

#: Shared report viewer (``CrashReportViewer.tsx``).
CRASH_VIEWER = "crash-report-viewer"
CRASH_VIEWER_TEXT = "crash-report-viewer-text"
CRASH_VIEWER_CLOSE = "crash-report-viewer-close"

#: The General-settings opt-out shared by both notices.
CRASH_NOTICE_SETTING = "settings-show-crash-report-notice"
CRASH_NOTICE_SETTING_KEY = "showCrashReportNotice"

#: Desktop-side cursor of the agent reports already seen (``agent_crash_notice.rs``).
AGENT_SEEN_STORE = "agent-crash-reports-seen.json"

#: The agent's crash-report dir on the deployed-agent container: the agent's
#: config dir is ``~/.config/termihub-agent`` and its log dir is ``logs/`` in it.
AGENT_CRASH_DIR = "/home/testuser/.config/termihub-agent/logs/crash-reports"

#: How long a notice must stay hidden for "no notice" to count. Both checks are
#: a sub-second local read (local) or one RPC on an open connection (agent).
NOTICE_QUIET_WINDOW = 5.0


def agent_crash_notice_testid(agent_id: str, action: str = "") -> str:
    """The agent crash notice (``action=""``) or one of its buttons (``"view"``…)."""
    return f"agent-crash-notice-{action}-{agent_id}" if action else f"agent-crash-notice-{agent_id}"


def crash_report_name(when: Optional[datetime] = None, pid: int = 4242) -> str:
    """A report file name the app accepts, sorting by ``when`` (UTC, now by default)."""
    when = (when or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return f"crash-{when.strftime('%Y%m%dT%H%M%SZ')}-{pid}.txt"


def crash_report_names(count: int, pid: int = 4242) -> list[str]:
    """``count`` report names, one second apart, in ascending (chronological) order.

    Starts now, so each batch sorts after any report seeded earlier in the run
    (the notices only fire for a report newer than the last one seen) and stays
    well inside the 30-day pruning window.
    """
    start = datetime.now(timezone.utc)
    return [crash_report_name(start + timedelta(seconds=i), pid) for i in range(count)]


def crash_report_text(marker: str, *, secrets: str = "") -> str:
    """The body of a seeded report, shaped like ``render_report``'s output.

    ``marker`` identifies the report in the viewer; ``secrets`` is appended to the
    message so a test can check what the viewer redacts.
    """
    message = f"seeded crash {marker}" + (f" {secrets}" if secrets else "")
    return (
        "termiHub crash report\n"
        "=====================\n"
        "app:       termiHub system test\n"
        "version:   0.0.0\n"
        "thread:    main\n"
        "location:  seeded.rs:1:1\n"
        "\n"
        f"message:\n{message}\n"
        "\n"
        "backtrace:\n(not captured)\n"
    )


class CrashReportUi(HarnessMixin):
    """Seed crash reports and drive the local / agent crash notices."""

    if TYPE_CHECKING:  # supplied by SystemTest / SettingsUi
        app: AppInstance

        @property
        def config_dir(self) -> Path: ...

        def open_settings_category(self, category: str) -> None: ...

        def persisted_settings(self) -> dict[str, Any]: ...

    # ── local reports (#3571) ──────────────────────────────────────────────────
    @property
    def crash_reports_dir(self) -> Path:
        """``crash-reports/`` in this app instance's isolated log dir."""
        return self.app.log_dir / "crash-reports"

    def seed_local_crash_report(self, name: str, text: str) -> Path:
        """Write one local crash report. Do it while the app is down."""
        self.crash_reports_dir.mkdir(parents=True, exist_ok=True)
        path = self.crash_reports_dir / name
        path.write_text(text, encoding="utf-8")
        return path

    def notified_crash_report(self) -> str:
        """The newest local report the user was told about (``""`` if none)."""
        try:
            return (self.crash_reports_dir / ".notified").read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    # ── agent reports (#3593) ──────────────────────────────────────────────────
    def agent_seen_store(self) -> dict[str, Any]:
        """Per-agent ``{"newestSeen": …}`` entries the desktop remembers."""
        try:
            doc = json.loads((self.config_dir / AGENT_SEEN_STORE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        agents = doc.get("agents") if isinstance(doc, dict) else None
        return agents if isinstance(agents, dict) else {}

    def agent_seen_entry(self, agent_id: str) -> Optional[dict[str, Any]]:
        """This agent's seen-store entry; ``None`` until its first check."""
        entry = self.agent_seen_store().get(agent_id)
        return entry if isinstance(entry, dict) else None

    # ── notices + viewer ───────────────────────────────────────────────────────
    def wait_notice_visible(self, test_id: str) -> None:
        self.wait(lambda: self.driver.exists(test_id), what=f"the {test_id} notice")

    def assert_notice_stays_hidden(
        self, test_id: str, seconds: float = NOTICE_QUIET_WINDOW
    ) -> None:
        """Fail if ``test_id`` shows up at any point in the next ``seconds``."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert not self.driver.exists(test_id), f"{test_id} appeared but should not have"
            time.sleep(0.25)

    def view_crash_report(self, view_button: str) -> str:
        """Click a notice's View Report button and return the viewer's report text."""
        self.driver.click(view_button)
        self.wait(lambda: self.driver.exists(CRASH_VIEWER_TEXT), what="the crash report viewer")
        return self.wait(
            lambda: (lambda t: t if t and t != "Loading…" else None)(
                self.driver.get_text(CRASH_VIEWER_TEXT)
            ),
            what="the crash report text to load",
        )

    def close_crash_report_viewer(self) -> None:
        self.driver.click(CRASH_VIEWER_CLOSE)
        self.wait(
            lambda: not self.driver.exists(CRASH_VIEWER), what="the crash report viewer to close"
        )

    def crash_notice_setting(self) -> bool:
        """The persisted opt-out state (absent = on)."""
        return self.persisted_settings().get(CRASH_NOTICE_SETTING_KEY, True) is not False

    def set_crash_notice_enabled(self, enabled: bool) -> None:
        """Flip General → Crash Report Notice like a user and wait until it is saved."""
        self.open_settings_category("general")
        self.wait(
            lambda: self.driver.exists(CRASH_NOTICE_SETTING), what="the crash notice toggle"
        )
        wanted = "true" if enabled else "false"
        if self.driver.get_attribute(CRASH_NOTICE_SETTING, "aria-checked") != wanted:
            self.driver.click(CRASH_NOTICE_SETTING)
        self.wait(
            lambda: self.crash_notice_setting() is enabled,
            what=f"{CRASH_NOTICE_SETTING_KEY}={enabled} saved to settings.json",
        )
