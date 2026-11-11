"""Scheduled runs through the real app: fire once, pause, resume (#5226).

The scheduler commands have mock-app unit coverage (#5168,
``src-tauri/src/commands/schedules_tests.rs``). This journey drives the parts
those tests cannot: the backend tick loop on the real wall clock, the window's
``schedule-fire`` listener playing the macro into a connected terminal, and the
ack/report round trip that records the attempt.

There is no test clock: the app ticks every 15 s on the wall clock and the
shortest rule is a 1-minute interval (``MIN_INTERVAL_MINUTES``), anchored at the
moment the schedule is enabled. So the journey takes three real slots, about
three and a half minutes:

1. **Slot 1** — the enabled schedule fires once and the run completes.
2. **Slot 2** — scheduling is paused: the tick passes the slot (the next run
   moves on to slot 3) but no attempt is recorded.
3. **Slot 3** — after resuming, the schedule fires at slot 3, not on resume:
   the paused slot is not replayed as a catch-up, and the history holds exactly
   the two completed runs.

The schedule is authored like a user would: a local-shell connection opened
from the sidebar, a one-step macro, the macro row's Schedule action, then
Settings -> Schedules to enable (with the first-enable confirmation) and to
pause/resume. Experimental features stay off; none of this needs them.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: The backend tick period (``schedules::runner::TICK_PERIOD``).
TICK = timedelta(seconds=15)

#: Budget for one slot to fire and settle: the 1-minute interval, a tick, and
#: headroom for a loaded CI runner.
SLOT_BUDGET = 180.0

EDITOR = "schedule-editor-dialog"
CONFIRM = "schedule-enable-confirm"
PAUSE_TOGGLE = "schedules-pause-toggle"


def _parse_ts(value: str) -> datetime:
    """Parse the backend's RFC 3339 timestamps (Python 3.9 compatible).

    ``fromisoformat`` before 3.11 rejects a ``Z`` suffix and more than six
    fractional digits, and chrono writes up to nine.
    """
    text = value.strip().replace("Z", "+00:00")
    text = re.sub(r"\.(\d{6})\d+", r".\1", text)
    return datetime.fromisoformat(text).astimezone(timezone.utc)


class TestScheduledRuns(ConnectionsUi, TabsUi, SidebarUi, SettingsUi, SystemTest):
    """One 1-minute interval schedule: fires once, skips while paused, resumes."""

    def reset_before_rerun(self) -> None:
        # A failed attempt can leave a dialog open, scheduling paused, or its
        # 1-minute schedule still enabled — which would fire into the rerun's
        # terminal and make its runs skip as "another scheduled run".
        self.dismiss_modals(EDITOR, CONFIRM, "macro-editor-dialog")
        self._open_schedules_settings()
        for s in self._schedules():
            if s.get("enabled"):
                self.driver.click(f"schedule-enable-{s['id']}")
        self.wait(
            lambda: not any(s.get("enabled") for s in self._schedules()),
            what="leftover schedules to disable",
        )
        self._set_paused(False)

    # ── state ────────────────────────────────────────────────────────────────
    def _schedules(self) -> list[dict[str, Any]]:
        return [s for s in self.driver.get_state("schedules") or [] if isinstance(s, dict)]

    def _schedule(self, schedule_id: str) -> dict[str, Any]:
        found = next((s for s in self._schedules() if s.get("id") == schedule_id), None)
        assert found is not None, f"schedule {schedule_id} disappeared"
        return found

    def _history(self, schedule_id: str) -> list[dict[str, Any]]:
        return list(self._schedule(schedule_id).get("history") or [])

    def _paused(self) -> bool:
        return bool(self.driver.get_state("schedulesPaused"))

    # ── authoring ────────────────────────────────────────────────────────────
    def _open_schedules_settings(self) -> None:
        self.open_settings_category("schedules")
        self.wait(lambda: self.driver.exists("schedules-section"), what="Settings -> Schedules")

    def _set_paused(self, paused: bool) -> None:
        """Flip the "Pause all" switch like a user and wait for the backend."""
        if self._paused() == paused:
            return
        self.wait(lambda: self.driver.exists(PAUSE_TOGGLE), what="the Pause all switch")
        self.driver.click(PAUSE_TOGGLE)
        self.wait(lambda: self._paused() == paused, what=f"scheduling paused={paused}")

    def _create_macro(self, name: str, step_text: str) -> str:
        """Author a one-step macro in the Macros sidebar; return its id."""
        self._ensure_sidebar("macros", "activity-bar-macros")
        self.wait(lambda: self.driver.exists("macro-sidebar"), what="the Macros sidebar")
        self.invoke_toolbar_action("macro-new-btn", overflow="macro-toolbar-overflow")
        self.wait(lambda: self.driver.exists("macro-editor-dialog"), what="the macro editor")
        self.driver.type("macro-editor-name", name)
        self.wait(
            lambda: self.driver.exists("macro-editor-step-data-0")
            or self.driver.exists("macro-editor-no-steps"),
            what="the macro editor's steps",
        )
        if not self.driver.exists("macro-editor-step-data-0"):
            self.driver.click("macro-editor-add-step")
        self.wait(
            lambda: self.driver.exists("macro-editor-step-data-0"), what="the first macro step"
        )
        self.driver.type("macro-editor-step-data-0", step_text)
        self.wait(lambda: not self.is_disabled("macro-editor-save"), what="Save to enable")
        self.driver.click("macro-editor-save")
        self.wait(
            lambda: not self.driver.exists("macro-editor-dialog"), what="the macro editor to close"
        )
        macro = self.wait(
            lambda: next(
                (m for m in self.driver.get_state("macros") or [] if m.get("name") == name),
                None,
            ),
            what=f"the saved macro {name!r}",
        )
        return macro["id"]

    def _create_schedule(self, name: str, macro_id: str, connection_id: str) -> str:
        """Schedule the macro every minute on the connection; return its id."""
        self.driver.click(f"macro-schedule-{macro_id}")
        self.wait(lambda: self.driver.exists(EDITOR), what="the schedule editor")
        self.driver.type("schedule-editor-name", name)
        checkbox = f"schedule-editor-connection-{connection_id}"
        self.wait(lambda: self.driver.exists(checkbox), what="the target connection checkbox")
        self.driver.click(checkbox)
        self.driver.type("schedule-editor-every", "1")
        self.wait(lambda: not self.is_disabled("schedule-editor-save"), what="Save to enable")
        self.driver.click("schedule-editor-save")
        self.wait(lambda: not self.driver.exists(EDITOR), what="the schedule editor to close")
        schedule = self.wait(
            lambda: next((s for s in self._schedules() if s.get("name") == name), None),
            what=f"the saved schedule {name!r}",
        )
        assert schedule["rule"] == {"kind": "interval", "everyMinutes": 1}
        assert schedule["action"] == {"kind": "macro", "macroId": macro_id}
        assert schedule["targets"] == {"kind": "connections", "connectionIds": [connection_id]}
        assert not schedule["enabled"], "a new schedule must start disabled"
        return schedule["id"]

    def _enable_with_confirmation(self, schedule_id: str) -> None:
        """First enable: the target-host confirmation must come up and be accepted."""
        self._open_schedules_settings()
        toggle = f"schedule-enable-{schedule_id}"
        self.wait(lambda: self.driver.exists(toggle), what="the schedule's enable switch")
        self.driver.click(toggle)
        self.wait(lambda: self.driver.exists(CONFIRM), what="the enable confirmation")
        self.driver.click(f"{CONFIRM}-confirm")
        self.wait(lambda: self._schedule(schedule_id).get("enabled"), what="the schedule enabled")
        assert self._schedule(schedule_id).get("confirmedAt"), "enable was not confirmed"

    # ── waits ────────────────────────────────────────────────────────────────
    def _next_run(self, schedule_id: str) -> Optional[datetime]:
        raw = self._schedule(schedule_id).get("nextRunAt")
        return _parse_ts(raw) if raw else None

    def _wait_for_runs(self, schedule_id: str, count: int, what: str) -> list[dict[str, Any]]:
        """Wait until ``count`` attempts are recorded and none is in flight."""

        def settled() -> Optional[list[dict[str, Any]]]:
            s = self._schedule(schedule_id)
            history = list(s.get("history") or [])
            return history if len(history) >= count and not s.get("running") else None

        return self.wait(settled, timeout=SLOT_BUDGET, interval=1.0, what=what)

    def _assert_completed_run(self, attempt: dict[str, Any], due: datetime) -> None:
        assert attempt.get("outcome") == "completed", attempt
        assert not attempt.get("catchUp"), f"an on-time run was recorded as catch-up: {attempt}"
        started = _parse_ts(attempt["startedAt"])
        # The tick fires a due slot on or after it, never early.
        assert started >= due - timedelta(seconds=1), (started, due)
        run_ids = attempt.get("macroRunIds") or []
        assert len(run_ids) == 1, attempt
        runs = {r.get("id"): r for r in self.driver.get_state("macroRuns") or []}
        assert runs.get(run_ids[0], {}).get("origin") == "scheduled", runs.get(run_ids[0])

    # ── the journey ──────────────────────────────────────────────────────────
    def test_fires_once_then_pause_skips_and_resume_does_not_replay(self):
        conn_name = unique_name("sched-target")
        self.create_local_connection(conn_name)
        connection_id = self.require_stable_connection(conn_name)["id"]
        # Connect from the sidebar: that tab carries the saved connection's id,
        # which is what a schedule targets. A Save & Connect tab does not (#5257).
        self.connect_connection(conn_name)
        self.wait(
            lambda: (self.find_tab(conn_name) or {}).get("connectionId") == connection_id,
            what=f"the {conn_name!r} terminal tab for connection {connection_id}",
        )

        macro_id = self._create_macro(unique_name("sched-macro"), "echo sched-tick\\r")
        schedule_id = self._create_schedule(unique_name("sched"), macro_id, connection_id)
        self._enable_with_confirmation(schedule_id)

        # Slot 1: fires exactly once and completes.
        slot1 = self.wait(lambda: self._next_run(schedule_id), what="the first next-run time")
        history = self._wait_for_runs(schedule_id, 1, "the first scheduled run to settle")
        assert len(history) == 1, history
        self._assert_completed_run(history[0], slot1)
        assert self._schedule(schedule_id)["lastResult"] == history[0]

        # Slot 2: paused. The tick passes the slot — the next run moves past it —
        # but nothing fires and no attempt is recorded.
        slot2 = self.wait(
            lambda: (lambda n: n if n and n > slot1 else None)(self._next_run(schedule_id)),
            what="the second next-run time",
        )
        self._set_paused(True)
        self.wait(
            lambda: self.driver.get_text(f"schedule-status-{schedule_id}") == "Paused",
            what="the schedule's status to read Paused",
        )
        self.wait(
            lambda: (lambda n: n is not None and n > slot2)(self._next_run(schedule_id)),
            timeout=SLOT_BUDGET,
            interval=1.0,
            what="the paused tick to pass the second slot",
        )
        # One more tick so a late fire would have had its chance to show up.
        time.sleep(TICK.total_seconds() + 2)
        assert len(self._history(schedule_id)) == 1, self._history(schedule_id)
        assert not self._schedule(schedule_id).get("running")

        # Slot 3: resumed. The next slot fires on time; the paused one is not
        # replayed on resume.
        self._set_paused(False)
        slot3 = self.wait(lambda: self._next_run(schedule_id), what="the next run after resume")
        assert slot3 > slot2, (slot3, slot2)
        history = self._wait_for_runs(schedule_id, 2, "the run after resuming to settle")
        assert len(history) == 2, f"expected the resumed run only, got {history}"
        self._assert_completed_run(history[0], slot3)
        assert history[1]["startedAt"] != history[0]["startedAt"]
