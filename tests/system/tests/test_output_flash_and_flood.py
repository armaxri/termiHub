"""Output-stream flash grades and the output-flood sampler (#4931).

Retires two "watch the screen" release checks into plain asserts:

* **MT-LOCAL-05 — no SSH connect / setup-command flash.** The bridge's raw
  output tap (``readTerminalOutput``) records every byte the terminal was
  handed from the moment the tab registered, escapes intact. A *flash* is text
  that is painted and then wiped (screen clear, reset, alternate screen) before
  the user gets the prompt; the tap shows it even though the wiped text is gone
  from the buffer ``readTerminal`` reads. The grade also asserts that none of
  termiHub's shell-integration setup text reaches the terminal at all — not
  even before the first prompt (#5009: the typed setup is hidden). The same
  grades run on a local shell on every OS, which also proves the tap works on
  all three WebView engines.
* **MT-LOCAL-32 — an output flood stays bounded and Ctrl+C stops it.** ``yes``
  floods a POSIX terminal (Git Bash on Windows) for 30 s while the harness
  samples the resident memory of the test app **and its WebView processes** by
  the app's own PID (``termihub_harness.process_sampler``) and times bridge
  round trips, which run on the WebView's JS thread, as the responsiveness
  probe. Then Ctrl+C must stop the output promptly and give a prompt back.

MT-LOCAL-03 (the WSL variant of the flash grade) stays guided: no CI lane runs
the desktop app against a real WSL distribution (``wsl-live.yml`` builds and
tests only the core crate, where ``live_wsl_session_sources_init_script_
silently_self_cleans_and_tracks_cwd`` already asserts the setup body never
reaches the terminal).

Every run records its measurements in the ``[termihub-test-timing]`` summary
(``measure:*`` ops); the thresholds below are sized from those (see
``docs/testing.md`` → "Output-stream flash and flood grades").
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Any, Optional

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness import timing
from termihub_harness.output_stream import (
    describe,
    find_flashes,
    markers_in,
    prompt_offsets,
)
from termihub_harness.process_sampler import (
    MemorySample,
    ProcessTreeSampler,
    mib,
    percentile,
    windowed_growth,
)

pytestmark = pytest.mark.integration

NEW_TERMINAL = "terminal-view-new-terminal"

#: Visible text termiHub's shell-integration setup line contains; none of it may
#: reach the terminal (#5009).
SETUP_MARKERS = ("__termihub_osc7", "__termihub_si", "PROMPT_COMMAND", "precmd_functions")

#: How long the stream must stay quiet before the start of a session counts as
#: settled (no more setup or prompt bytes in flight).
SETTLE_QUIET_MS = 1500.0

# ── MT-LOCAL-32 grade ─────────────────────────────────────────────────────────
# Sized from measured CI runs of this test on the bulk integration lane (2
# xdist workers on macOS/Windows): six flood rounds per OS with recorded values
# (three in dispatch run 40053707527, three attempts in 40059671630) plus three
# that passed the looser provisional bounds in 40047063122. The observed maxima
# and the headroom are in docs/testing.md → "Output-stream flash and flood
# grades". RSS on macOS swings widely between runs (−185 to +338 MiB: WKWebView
# process attribution and memory compression), Linux WebKitGTK under Xvfb is
# slow, so the memory and latency ceilings are per OS.
FLOOD_SECONDS = 30.0
SAMPLE_INTERVAL = 0.5
#: Median-RSS window compared at the start and the end of the flood.
GROWTH_WINDOW = 5.0
#: Ceiling on RSS growth across the flood (end-window median − start-window
#: median), MiB. Observed max: Linux 173.5, macOS 338.2, Windows 85.4.
MAX_FLOOD_GROWTH_MIB = {"linux": 350.0, "macos": 600.0, "windows": 200.0}
#: Ceiling on the 95th-percentile bridge round trip during the flood, seconds.
#: Observed max: Linux 4.71, macOS 3.14, Windows 1.94.
MAX_FLOOD_P95_LATENCY = {"linux": 10.0, "macos": 7.0, "windows": 5.0}
#: Ceiling from Ctrl+C until the output stops (observed max 3.76 s, Windows).
MAX_STOP_SECONDS = 8.0
#: Ceiling from Ctrl+C until a marker command's output is back (observed max
#: 5.28 s, Windows).
MAX_PROMPT_SECONDS = 12.0


def measure(tag: str, budgets: Optional[dict[str, float]] = None, **values: object) -> None:
    """Record one run's evidence for sizing the thresholds.

    Prints a ``[termihub-measure]`` line (visible on failure or with ``-s``) and
    records every numeric value as a ``measure:<tag>:<name>`` sample in the
    harness timing summary, so each CI run's ``[termihub-test-timing]`` lines
    carry n / p50 / p95 / max per OS (with the threshold as ``deadline``) even
    when the test passed and its output was captured.
    """
    fields = " ".join(f"{k}={v}" for k, v in values.items())
    print(f"\n[termihub-measure] {tag} {fields}", flush=True)
    for name, value in values.items():
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            budget = (budgets or {}).get(name, 0.0)
            timing.record(f"measure:{tag}:{name}", float(value), budget)


class _OutputTap:
    """Shared helpers for reading a tab's raw output stream (a mixin)."""

    if TYPE_CHECKING:  # provided by the suites this is combined with
        driver: Any

        def wait(self, condition: Any, *, timeout: float = ..., what: str = ...) -> Any: ...
        def active_tab(self) -> Optional[dict[str, Any]]: ...

    def active_tab_id(self) -> str:
        tab = self.wait(self.active_tab, what="an active tab")
        return tab["id"]

    def settled_output(self, tab_id: str, *, what: str, timeout: float = 60.0) -> str:
        """The tab's raw stream once a prompt mark arrived and output went quiet."""

        def settled() -> str | None:
            tap = self.driver.read_terminal_output(tab_id)
            quiet = tap["msSinceLastWrite"]
            if tap["writes"] and quiet is not None and quiet >= SETTLE_QUIET_MS:
                return tap["output"]
            return None

        return self.wait(settled, timeout=timeout, what=what)


class TestLocalShellFlash(_OutputTap, TerminalUi, TabsUi, SystemTest):
    """The no-flash grade on the platform's default local shell (all OSes)."""

    def test_local_shell_start_paints_no_flash(self):
        """MT-LOCAL-05 companion: a fresh local terminal wipes nothing it painted."""
        self.close_all_tabs()
        self.driver.click(NEW_TERMINAL)
        self.wait(lambda: self.tab_count() >= 1, what="the new terminal tab")
        tab_id = self.active_tab_id()
        self.wait(lambda: self.driver.read_terminal(tab_id).strip(), what="a shell prompt")
        raw = self.settled_output(tab_id, what="the local shell start to settle")
        flashes = find_flashes(raw)
        leaked = markers_in(raw, SETUP_MARKERS)
        measure(
            "local-shell-start",
            chars=len(raw),
            prompt_marks=len(prompt_offsets(raw)),
            flashes=len(flashes),
            leaked=leaked,
            raw=describe(raw, 1500),
        )
        assert not flashes, f"local shell start wiped painted text: {flashes}\n{describe(raw)}"
        assert not leaked, f"setup text {leaked} reached the terminal (#5009):\n{describe(raw)}"


@pytest.mark.usefixtures("ssh_password_fixtures")
class TestSshConnectFlash(
    _OutputTap, TerminalUi, TabsUi, ConnectionsUi, SidebarUi, PasswordPromptUi, SshUi, SystemTest
):
    """MT-LOCAL-05 against the Docker password-SSH container."""

    def test_ssh_connect_paints_no_setup_flash(self):
        """MT-LOCAL-05: no setup / wrapper command flash before the remote prompt."""
        self.close_all_tabs()
        self.connect_ssh_password(unique_name("ssh-flash"))
        tab_id = self.active_tab_id()
        self.wait(
            lambda: prompt_offsets(self.driver.read_terminal_output(tab_id)["output"]),
            timeout=60.0,
            what="the integration-marked (OSC 133;A) remote prompt",
        )
        raw = self.settled_output(tab_id, what="the SSH session start to settle")
        first_prompt = prompt_offsets(raw)[0]
        flashes = find_flashes(raw)
        leaked = markers_in(raw, SETUP_MARKERS)
        measure(
            "ssh-connect",
            chars=len(raw),
            first_prompt_at=first_prompt,
            flashes=len(flashes),
            leaked=leaked,
            raw=describe(raw, 3000),
        )
        assert not flashes, f"SSH connect wiped painted text: {flashes}\n{describe(raw)}"
        assert not leaked, (
            f"setup text {leaked} reached the terminal (#5009; first OSC 133;A at "
            f"{first_prompt}):\n{describe(raw)}"
        )


class TestOutputFlood(_OutputTap, TerminalUi, TabsUi, ConnectionsUi, SidebarUi, SystemTest):
    """MT-LOCAL-32: memory and responsiveness under ``yes``; Ctrl+C stops it."""

    def reset_before_rerun(self) -> None:
        self.reset_tabs()

    def _flood_samples(self, sampler: ProcessTreeSampler) -> tuple[list[MemorySample], list[float]]:
        """Sample RSS and time a bridge round trip every interval for the flood."""
        samples: list[MemorySample] = []
        latencies: list[float] = []
        end = time.monotonic() + FLOOD_SECONDS
        while time.monotonic() < end:
            tick = time.monotonic()
            samples.append(sampler.sample())
            start = time.monotonic()
            self.driver.exists(NEW_TERMINAL)
            latencies.append(time.monotonic() - start)
            time.sleep(max(0.0, SAMPLE_INTERVAL - (time.monotonic() - tick)))
        return samples, latencies

    def _wait_for_stop(self, tab_id: str, interrupted_at: float) -> float:
        """Seconds from Ctrl+C until the stream's last write (output stopped)."""

        def stopped() -> float | None:
            tap = self.driver.read_terminal_output(tab_id)
            read_at = time.monotonic()
            quiet = tap["msSinceLastWrite"]
            if quiet is not None and quiet >= 1000.0:
                return max(0.0, read_at - quiet / 1000.0 - interrupted_at)
            return None

        return self.wait(stopped, timeout=60.0, what="the flood output to stop")

    def test_output_flood_stays_bounded_and_ctrl_c_stops_it(self):
        """MT-LOCAL-32."""
        self.close_all_tabs()
        self.ensure_posix_terminal()
        tab_id = self.active_tab_id()
        pid = self.app.pid
        assert pid is not None, "the app under test has no PID"
        sampler = ProcessTreeSampler(pid)
        webviews = self.wait(
            lambda: sampler.webview_process_count() or None,
            what="the app's WebView processes (found from its PID)",
        )
        before = sampler.sample()

        self.run_command("yes")
        self.wait(
            lambda: self.driver.read_terminal_output(tab_id)["truncated"],
            what="the flood to start",
        )
        samples, latencies = self._flood_samples(sampler)

        interrupted_at = time.monotonic()
        self.driver.terminal_input("\x03", tab_id=tab_id)
        stop_seconds = self._wait_for_stop(tab_id, interrupted_at)
        self.driver.terminal_input("echo FLOOD-''STOPPED\n", tab_id=tab_id)
        self.wait_for_output("FLOOD-STOPPED", tab_id=tab_id, timeout=60.0)
        prompt_seconds = time.monotonic() - interrupted_at

        start, end, growth = windowed_growth(samples, window=GROWTH_WINDOW)
        host = timing.os_name()
        max_growth = MAX_FLOOD_GROWTH_MIB[host]
        max_p95 = MAX_FLOOD_P95_LATENCY[host]
        p95 = percentile(latencies, 95)
        written = self.driver.read_terminal_output(tab_id)["written"]
        measure(
            "output-flood",
            {
                "growth_mib": max_growth,
                "p95_latency_s": max_p95,
                "stop_s": MAX_STOP_SECONDS,
                "prompt_s": MAX_PROMPT_SECONDS,
            },
            webview_processes=webviews,
            idle_mib=round(mib(before.rss), 1),
            start_mib=round(mib(start), 1),
            end_mib=round(mib(end), 1),
            growth_mib=round(mib(growth), 1),
            peak_mib=round(mib(max(s.rss for s in samples)), 1),
            p50_latency_s=round(percentile(latencies, 50), 3),
            p95_latency_s=round(p95, 3),
            max_latency_s=round(max(latencies), 3),
            stop_s=round(stop_seconds, 2),
            prompt_s=round(prompt_seconds, 2),
            written_mib=round(mib(written), 1),
            processes=sorted(set(samples[-1].processes.values())),
        )
        assert self.app.is_running(), "the app died during the flood"
        assert "write data discarded" not in self.app.read_log()
        assert mib(growth) <= max_growth, (
            f"RSS grew {mib(growth):.1f} MiB during the flood "
            f"({mib(start):.0f} → {mib(end):.0f} MiB)"
        )
        assert p95 <= max_p95, f"p95 bridge round trip {p95:.2f}s during the flood"
        assert stop_seconds <= MAX_STOP_SECONDS, f"output kept coming {stop_seconds:.2f}s"
        assert prompt_seconds <= MAX_PROMPT_SECONDS, f"prompt back after {prompt_seconds:.2f}s"
