"""Performance suite — ported from the WebdriverIO ``performance.test.js`` and
``performance-stress.test.js`` to the Python bridge harness (#811).

Validates termiHub's design target of **40 concurrent local-shell terminals**
without degradation, and logs creation throughput, tab-switch latency, and
cleanup timing as baselines (run with ``-s`` to see them). The two original specs
covered the same PERF-01..04 against 40 terminals, so they are merged into this
one suite; their old files are removed.

The suite shares one app and stands the 40 terminals up once (PERF-01 measures
that from empty), then reuses them for the latency/input checks and tears them
down in PERF-04 (measuring cleanup). ``ensure_terminals`` tops up to the target,
so each test is robust to the shared state rather than strictly order-dependent.

Divergence from the original, by design:

* **JS-heap check** (old ``performance.test.js`` PERF-03, ``performance.memory``
  under 500 MB) is **dropped**: it relied on ``browser.execute`` to read a
  Chromium-only DevTools metric, which the cross-platform bridge has no verb for
  (and which was already skipped on non-Chromium engines). A heap/metrics bridge
  command would be the way to restore it — surfaced back to #800.
"""

from __future__ import annotations

import time

import pytest

from termihub_harness import SystemTest, TabsUi, TerminalUi

pytestmark = pytest.mark.integration

#: termiHub's documented design target for simultaneous local terminals.
TARGET_TERMINALS = 40

#: Latency ceilings (seconds) mirrored from the original WebdriverIO thresholds.
SWITCH_LATENCY_BUDGET = 2.0
NEW_TERMINAL_BUDGET = 5.0


class TestPerformance(TerminalUi, TabsUi, SystemTest):
    """One app; PERF-01 builds the 40 terminals, PERF-04 tears them down."""

    def ensure_terminals(self, target: int) -> float:
        """Open terminals until at least ``target`` tabs exist; return elapsed secs.

        Waits for each new tab to register rather than sleeping a fixed interval
        (the old spec's ``browser.pause(150)``), so it is both faster and not
        flaky under load. A no-op when the target is already met.
        """
        start = time.monotonic()
        self.ensure_terminal()  # the first terminal (handles the empty state)
        while self.tab_count() < target:
            expected = self.tab_count() + 1
            self.open_new_terminal()
            self.wait(
                lambda expected=expected: self.tab_count() >= expected,
                what=f"terminal #{expected}",
            )
        return time.monotonic() - start

    def test_perf_01_create_40_terminals(self):
        # Create the design-target 40 terminals from empty and report throughput.
        assert self.tab_count() == 0
        elapsed = self.ensure_terminals(TARGET_TERMINALS)

        count = self.tab_count()
        print(
            f"\n  [PERF-01] created {count} terminals in {elapsed:.1f}s "
            f"({elapsed / TARGET_TERMINALS * 1000:.0f}ms/terminal)"
        )
        assert count == TARGET_TERMINALS

    def test_perf_02_tab_switch_latency(self):
        # With 40 terminals open, switching to the first / middle / last tab must
        # make each active within the latency budget.
        self.ensure_terminals(TARGET_TERMINALS)
        ids = self.tab_ids()
        assert len(ids) >= TARGET_TERMINALS

        for label, idx in (("first", 0), ("middle", len(ids) // 2), ("last", len(ids) - 1)):
            target_id = ids[idx]
            start = time.monotonic()
            self.switch_to_tab(target_id)
            self.wait(
                lambda target_id=target_id: (self.active_tab() or {}).get("id") == target_id,
                what=f"the {label} tab to activate",
            )
            latency = time.monotonic() - start
            print(f"  [PERF-02] switch to {label} tab: {latency * 1000:.0f}ms")
            assert latency < SWITCH_LATENCY_BUDGET

    def test_perf_03_input_and_responsiveness_with_40_open(self):
        # Input still reaches the active terminal, and opening one more terminal
        # stays responsive, with 40 already open.
        self.ensure_terminals(TARGET_TERMINALS)

        # Target the active terminal explicitly by id and wait for its shell
        # prompt before typing, so input is not dropped on a not-yet-registered
        # session and is read back from the same terminal it was sent to.
        active = self.wait(self.active_tab, what="an active terminal tab")
        tab_id = active["id"]
        self.wait(
            lambda: self.driver.read_terminal(tab_id).strip(),
            what="the active terminal's shell prompt",
        )
        self.driver.terminal_input("echo perf-test\n", tab_id=tab_id)
        self.wait_for_output("perf-test", tab_id=tab_id)

        # The (41st) terminal opens promptly.
        before = self.tab_count()
        start = time.monotonic()
        self.open_new_terminal()
        self.wait(lambda: self.tab_count() > before, what="the 41st terminal")
        elapsed = time.monotonic() - start
        print(f"  [PERF-03] opened terminal #{before + 1} in {elapsed * 1000:.0f}ms")
        assert elapsed < NEW_TERMINAL_BUDGET

    def test_perf_04_close_all_terminals(self):
        # Closing every terminal cleans up to zero tabs within the budget.
        self.ensure_terminals(TARGET_TERMINALS)
        before = self.tab_count()

        start = time.monotonic()
        self.close_all_tabs()
        self.wait(lambda: self.tab_count() == 0, what="all tabs to close")
        elapsed = time.monotonic() - start

        print(
            f"\n  [PERF-04] closed {before} terminals in {elapsed:.1f}s "
            f"({elapsed / before * 1000:.0f}ms/terminal)"
        )
        assert self.tab_count() == 0
