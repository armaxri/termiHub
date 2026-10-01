"""Local crash-report notice end to end (#3571, OBS-010; automated in #4009).

The Rust and Vitest suites cover each piece in isolation: writing, listing,
pruning and the ``.notified`` marker (``core/src/diagnostics/crash_report_tests.rs``)
and the notice's buttons against a mocked API (``CrashReportNotice.test.tsx``).
This suite runs the real app over the real files: a report seeded into the app's
``crash-reports/`` dir before a launch raises the notice, **View Report** shows
the file, the next start shows no second notice, and **Don't show again**
persists across a restart.

The harness gives each app its own log dir (``TERMIHUB_LOG_DIR`` =
``<config dir>/logs``), so the reports are seeded there and never touch the
user's real log directory.
"""

from __future__ import annotations

import pytest

from termihub_harness import CrashReportUi, SettingsUi, SidebarUi, SystemTest, unique_name
from termihub_harness.ui.diagnostics import (
    CRASH_NOTICE,
    CRASH_NOTICE_DISMISS,
    CRASH_NOTICE_NEVER,
    CRASH_NOTICE_VIEW,
    crash_report_name,
    crash_report_names,
    crash_report_text,
)

pytestmark = pytest.mark.integration


class TestCrashReportNotice(CrashReportUi, SettingsUi, SidebarUi, SystemTest):
    """One app for the suite; each test seeds its reports and restarts.

    The tests run in file order and each seeds reports newer than the ones before
    it, because the notice only fires for a report newer than the last one the
    user was told about.
    """

    def test_a_clean_start_shows_no_notice(self):
        assert not any(self.crash_reports_dir.glob("crash-*.txt"))
        self.assert_notice_stays_hidden(CRASH_NOTICE)

    def test_view_report_then_the_next_start_shows_no_second_notice(self):
        marker = unique_name("crash-view")
        name = crash_report_name()
        self.restart_app(
            lambda: self.seed_local_crash_report(name, crash_report_text(marker))
        )

        self.wait_notice_visible(CRASH_NOTICE)
        text = self.view_crash_report(CRASH_NOTICE_VIEW)
        assert f"seeded crash {marker}" in text, text
        # Viewing acknowledges: the notice goes and the marker records the report.
        assert not self.driver.exists(CRASH_NOTICE)
        self.wait(
            lambda: self.notified_crash_report() == name,
            what="the viewed report to be recorded as notified",
        )
        self.close_crash_report_viewer()

        # Same report on disk, already notified: the next start stays quiet.
        self.restart_app()
        self.assert_notice_stays_hidden(CRASH_NOTICE)
        assert self.notified_crash_report() == name

    def test_dont_show_again_persists_across_a_restart(self):
        first, second = crash_report_names(2, pid=7000)
        # Both newer than the previous test's report (which used "now").
        assert first > self.notified_crash_report()

        self.restart_app(
            lambda: self.seed_local_crash_report(first, crash_report_text("opt-out-1"))
        )
        self.wait_notice_visible(CRASH_NOTICE)
        self.driver.click(CRASH_NOTICE_NEVER)
        self.wait(lambda: not self.driver.exists(CRASH_NOTICE), what="the notice to close")
        self.wait(
            lambda: self.crash_notice_setting() is False,
            what="showCrashReportNotice=false saved to settings.json",
        )
        self.wait(
            lambda: self.notified_crash_report() == first,
            what="the opted-out report to be recorded as notified",
        )

        # A newer crash while opted out: the opt-out survives the restart and the
        # notice stays hidden.
        self.restart_app(
            lambda: self.seed_local_crash_report(second, crash_report_text("opt-out-2"))
        )
        assert self.crash_notice_setting() is False
        self.assert_notice_stays_hidden(CRASH_NOTICE)
        assert self.notified_crash_report() == first, (
            "an opted-out start must not consume the pending report"
        )

        # Turning the notice back on in General settings brings the pending
        # report's notice back without a restart.
        self.set_crash_notice_enabled(True)
        self.wait_notice_visible(CRASH_NOTICE)
        self.driver.click(CRASH_NOTICE_DISMISS)
        self.wait(lambda: not self.driver.exists(CRASH_NOTICE), what="the notice to close")
        self.wait(
            lambda: self.notified_crash_report() == second,
            what="the dismissed report to be recorded as notified",
        )
