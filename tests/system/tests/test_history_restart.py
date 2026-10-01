"""Run histories survive an app restart (#4012).

Automates three of the per-feature manual walkthroughs the #3695 triage moved to
#4012. Each test performs the action that records history, waits until the
backend has written it to its JSON store in the suite's isolated config dir,
kills and relaunches the app with :meth:`~termihub_harness.SystemTest.restart_app`,
asserts the history is shown again, then clears it:

* **Network tool run history (PROD-032)** — ping ``127.0.0.1``, stop, restart,
  the ping panel's History row is back and Re-run refills the host field; Clear
  empties it. Then, with recording turned off in Settings → Sessions, a new ping
  is not recorded.
* **Macro run history (#3543)** — play a hand-authored macro into a local
  terminal from the Macros sidebar; the per-macro filter narrows the history
  panel; restart, the playback row is back; Clear history empties it.
* **HTTP monitor check history (#3462)** — monitor a local stdlib HTTP server
  (the per-monitor "Private network" opt-in allows the loopback target, #4021),
  stop, restart; "Show checks" restores the chart and table, Resume appends a
  check, Remove drops the monitor and its stored checks.

Every history is written by the backend when it is recorded (the monitor's
checks are flushed on Stop), so each test waits for the file on disk before the
ungraceful kill rather than relying on a graceful shutdown. Tabs are closed
before each restart so session restore does not reopen the panels.
"""

from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler
from typing import Any, Iterator, Optional

import pytest

from termihub_harness import (
    SETTINGS_REGION,
    LocalThreadingHTTPServer,
    NetworkToolsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

NETWORK_HISTORY_FILE = "network-tool-history.json"
MACRO_RUNS_FILE = "macro-runs.json"
HTTP_MONITORS_FILE = "http-monitors.json"
HTTP_MONITOR_HISTORY_FILE = "http-monitor-history.json"

HISTORY_TOGGLE = "network-history-toggle"
HISTORY_ROW = "network-history-row"
HISTORY_EMPTY = "network-history-empty"
HISTORY_RECORDING_TOGGLE = "settings-network-tool-history-enabled"

#: How many rows the monitor's "Recent Checks" table lists at most.
MONITOR_TABLE_ROWS = 20


@pytest.fixture
def http_target() -> Iterator[int]:
    """A free localhost HTTP server returning ``200 OK`` — the monitor's target.

    It outlives the app restart inside the test, so the resumed monitor polls the
    same URL it recorded checks against.
    """

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (stdlib naming)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *_args):  # silence per-request stderr logging
            pass

    # Not ThreadingHTTPServer: its server_bind does a slow reverse-DNS lookup (#3665).
    server = LocalThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


class TestHistoryRestart(NetworkToolsUi, TerminalUi, SidebarUi, SettingsUi, TabsUi, SystemTest):
    """One app; each test records history, restarts the app, and clears it."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.stop_ping()
        self.stop_http_monitor()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    # ── on-disk stores ───────────────────────────────────────────────────────
    def _read_store(self, file_name: str) -> dict[str, Any]:
        """A config-dir JSON store (``{}`` while absent or mid-write)."""
        try:
            data = json.loads((self.config_dir / file_name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _stored_network_runs(self, tool: str) -> list[dict[str, Any]]:
        runs = self._read_store(NETWORK_HISTORY_FILE).get("runs") or []
        return [r for r in runs if isinstance(r, dict) and r.get("tool") == tool]

    def _stored_macro_runs(self) -> list[dict[str, Any]]:
        runs = self._read_store(MACRO_RUNS_FILE).get("runs") or []
        return [r for r in runs if isinstance(r, dict)]

    def _stored_monitor_id(self, url: str) -> Optional[str]:
        monitors = self._read_store(HTTP_MONITORS_FILE).get("monitors") or []
        return next(
            (m.get("id") for m in monitors if isinstance(m, dict) and m.get("url") == url),
            None,
        )

    def _stored_monitor_checks(self, monitor_id: str) -> list[dict[str, Any]]:
        series = self._read_store(HTTP_MONITOR_HISTORY_FILE).get("monitors") or []
        for entry in series:
            if isinstance(entry, dict) and entry.get("id") == monitor_id:
                return [c for c in entry.get("checks") or [] if isinstance(c, dict)]
        return []

    # ── network-tool history panel ───────────────────────────────────────────
    def _expand_network_history(self) -> None:
        """Expand the active tool panel's collapsible History section."""
        self.wait(lambda: self.driver.exists(HISTORY_TOGGLE), what="the History toggle")
        if self.driver.get_attribute(HISTORY_TOGGLE, "aria-expanded") != "true":
            self.driver.click(HISTORY_TOGGLE)
        self.wait(
            lambda: self.driver.get_attribute(HISTORY_TOGGLE, "aria-expanded") == "true",
            what="the History section to expand",
        )

    def _ping_until_reply_then_stop(self) -> None:
        """Ping loopback until a reply streams in, then stop (a ``canceled`` run)."""
        self.wait(
            lambda: re.search(r"Received:\s*[1-9]", self.driver.get_text("ping-stats") or ""),
            what="ping replies to stream in",
        )
        self.stop_ping()
        self.wait(lambda: self.driver.exists("ping-start"), what="the ping to stop")

    def _set_network_history_recording(self, enabled: bool) -> None:
        """Flip Settings → Sessions → Record Network Tool History like a user.

        Clicking the toggle goes through the Settings editor, which persists to
        ``settings.json`` (a bare ``settings.patch`` would not, #4017); wait for
        both the region and the file before relying on it.
        """

        def region_enabled() -> bool:
            value = self.projection_region_cache(SETTINGS_REGION).get("networkToolHistoryEnabled")
            return value is not False

        if region_enabled() == enabled:
            return
        self.open_settings_category("sessions")
        self.wait(
            lambda: self.driver.exists(HISTORY_RECORDING_TOGGLE),
            what="the Record Network Tool History toggle",
        )
        self.driver.click(HISTORY_RECORDING_TOGGLE)
        self.wait(lambda: region_enabled() == enabled, what=f"history recording={enabled}")
        self.wait(
            lambda: (self.persisted_settings().get("networkToolHistoryEnabled") is not False)
            == enabled,
            what=f"history recording={enabled} saved to settings.json",
        )

    # ── macros ───────────────────────────────────────────────────────────────
    def _open_macros_sidebar(self) -> None:
        self._ensure_sidebar("macros", "activity-bar-macros")
        self.wait(lambda: self.driver.exists("macro-sidebar"), what="the Macros sidebar")

    def _create_macro(self, name: str, step_text: str) -> str:
        """Author a one-step macro in the editor dialog; return its id."""
        self.driver.click("macro-new-btn")
        self.wait(lambda: self.driver.exists("macro-editor-dialog"), what="the macro editor")
        self.driver.type("macro-editor-name", name)
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

    # ── PROD-032: network tool run history ───────────────────────────────────
    def test_network_tool_run_history_survives_restart(self):
        self.start_ping("127.0.0.1")
        self._ping_until_reply_then_stop()
        self._expand_network_history()
        self.wait(lambda: self.driver.exists(HISTORY_ROW), what="the recorded ping run")
        self.wait(lambda: self._stored_network_runs("ping"), what=f"the run in {NETWORK_HISTORY_FILE}")

        self.close_all_tabs()
        self.restart_app()

        # The row is back after the relaunch, loaded from the backend store.
        self.open_tool_panel("ping", "ping-panel")
        self._expand_network_history()
        self.wait(lambda: self.driver.exists(HISTORY_ROW), what="the ping run after restart")

        # Re-run refills the host field from the recorded params and starts a run.
        self.driver.type("ping-host", "")
        self.driver.click("network-history-rerun")
        self.wait(
            lambda: self.driver.get_value("ping-host") == "127.0.0.1",
            what="Re-run to refill the host",
        )
        self._ping_until_reply_then_stop()

        # Clear (confirmed) empties both the panel and the store.
        self.driver.click("network-history-clear")
        self.wait(
            lambda: self.driver.exists("network-history-clear-confirm"),
            what="the clear-history confirmation",
        )
        self.driver.click("network-history-clear-confirm")
        self.wait(lambda: self.driver.exists(HISTORY_EMPTY), what="the history to clear")
        self.wait(
            lambda: not self._stored_network_runs("ping"),
            what=f"the ping runs to leave {NETWORK_HISTORY_FILE}",
        )

        # With recording off a finished run is not kept, and the panel says so.
        self.close_all_tabs()
        self._set_network_history_recording(False)
        try:
            self.start_ping("127.0.0.1")
            self._ping_until_reply_then_stop()
            self._expand_network_history()
            assert self.driver.exists("network-history-disabled")
            assert self.driver.exists(HISTORY_EMPTY)
            assert not self.driver.exists(HISTORY_ROW)
            assert not self._stored_network_runs("ping")
        finally:
            self.close_all_tabs()
            self._set_network_history_recording(True)

    # ── #3543: macro run history ─────────────────────────────────────────────
    def test_macro_run_history_survives_restart(self):
        self.ensure_terminal()
        self._open_macros_sidebar()
        played_id = self._create_macro(unique_name("hist-macro"), "echo macro-history\\r")
        other_id = self._create_macro(unique_name("hist-idle"), "echo idle\\r")

        # Play into the active local terminal from the sidebar (origin "manual").
        self.driver.click(f"macro-play-{played_id}")
        run = self.wait(
            lambda: next(
                (
                    r
                    for r in self.driver.get_state("macroRuns") or []
                    if r.get("macroId") == played_id and r.get("status") == "completed"
                ),
                None,
            ),
            what="the completed macro playback in the run history",
        )
        run_id = run["id"]
        assert run.get("origin") == "manual"
        self.wait(lambda: self.driver.exists(f"macro-run-{run_id}"), what="the playback row")

        # The per-macro filter narrows the panel: the idle macro has no playbacks,
        # the played one shows its row; "Show all" drops the filter.
        self.driver.click(f"macro-history-{other_id}")
        self.wait(lambda: self.driver.exists("macro-history-filter"), what="the macro filter")
        self.wait(lambda: self.driver.exists("macro-history-empty"), what="an empty filtered list")
        self.driver.click(f"macro-history-{played_id}")
        self.wait(
            lambda: self.driver.exists(f"macro-run-{run_id}"), what="the filtered playback row"
        )
        self.driver.click("macro-history-show-all")
        self.wait(
            lambda: not self.driver.exists("macro-history-filter"), what="the filter to clear"
        )

        self.wait(
            lambda: any(r.get("id") == run_id for r in self._stored_macro_runs()),
            what=f"the playback in {MACRO_RUNS_FILE}",
        )
        self.close_all_tabs()
        self.restart_app()

        self._open_macros_sidebar()
        self.wait(
            lambda: self.driver.exists(f"macro-run-{run_id}"), what="the playback row after restart"
        )
        restored = next(r for r in self.driver.get_state("macroRuns") or [] if r["id"] == run_id)
        assert restored.get("status") == "completed"
        assert restored.get("origin") == "manual"

        self.driver.click("macro-history-clear")
        self.wait(lambda: self.driver.exists("macro-history-empty"), what="the history to clear")
        assert not self.driver.get_state("macroRuns")
        self.wait(
            lambda: not self._stored_macro_runs(), what=f"the runs to leave {MACRO_RUNS_FILE}"
        )

    # ── #3462: HTTP monitor check history ────────────────────────────────────
    def _shown_check_rows(self) -> int:
        """How many rows the "Recent Checks" table currently lists."""
        count = 0
        while count < MONITOR_TABLE_ROWS and self.driver.exists(f"http-monitor-entry-{count}"):
            count += 1
        return count

    def test_http_monitor_check_history_survives_restart(self, http_target: int):
        url = f"http://127.0.0.1:{http_target}"
        self.start_http_monitor(url, allow_private_network=True)
        self.wait(lambda: self.driver.exists("http-monitor-entry-0"), what="the first check")
        monitor_id = self.wait(
            lambda: self._stored_monitor_id(url), what=f"the monitor in {HTTP_MONITORS_FILE}"
        )

        # Stop keeps the monitor listed (stopped) and flushes its checks to disk.
        self.stop_http_monitor()
        self.wait(
            lambda: self.driver.exists(f"monitor-resume-{monitor_id}"),
            what="the monitor to list as stopped",
        )
        self.wait(
            lambda: self._stored_monitor_checks(monitor_id),
            what=f"the checks in {HTTP_MONITOR_HISTORY_FILE}",
        )

        self.close_all_tabs()
        self.restart_app()

        # "Show checks" rehydrates the chart and table from the stored history.
        self.open_http_monitor()
        self.wait(
            lambda: self.driver.exists(f"monitor-show-{monitor_id}"),
            what="the stopped monitor after restart",
        )
        self.driver.click(f"monitor-show-{monitor_id}")
        self.wait(lambda: self.driver.exists("http-monitor-entry-0"), what="the restored checks")
        self.wait(lambda: self.driver.exists("http-monitor-chart"), what="the restored chart")
        assert "200" in (self.driver.get_text("http-monitor-history") or "")

        # Resume appends: the immediate first check lands beneath the restored ones.
        shown = self._shown_check_rows()
        self.driver.click(f"monitor-resume-{monitor_id}")
        if shown < MONITOR_TABLE_ROWS:
            self.wait(
                lambda: self.driver.exists(f"http-monitor-entry-{shown}"),
                what="a new check appended after Resume",
            )
        self.wait(lambda: self.driver.exists("http-monitor-stop"), what="the resumed monitor to run")
        self.stop_http_monitor()
        self.wait(
            lambda: self.driver.exists(f"monitor-resume-{monitor_id}"),
            what="the resumed monitor to stop",
        )

        # Remove drops the monitor and its recorded checks.
        self.driver.click(f"monitor-remove-{monitor_id}")
        # (The sidebar's Monitors section reuses ``monitor-row-<id>``, so wait on the
        # panel-only Show button instead.)
        self.wait(
            lambda: not self.driver.exists(f"monitor-show-{monitor_id}"),
            what="the monitor to be removed",
        )
        assert not self.driver.exists("http-monitor-history")
        self.wait(
            lambda: not self._stored_monitor_checks(monitor_id),
            what=f"the checks to leave {HTTP_MONITOR_HISTORY_FILE}",
        )
        self.wait(
            lambda: self._stored_monitor_id(url) is None,
            what=f"the monitor to leave {HTTP_MONITORS_FILE}",
        )
