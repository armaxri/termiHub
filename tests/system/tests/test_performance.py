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

Reruns (the nightly lane's ``--reruns``) reuse the class's app, so a rerun would
inherit whatever a failed attempt left open. ``reset_before_rerun`` closes every
tab first, so each rerun starts clean and a PERF-01 rerun fails (if at all) on
the real error, not on ``assert 12 == 0`` from the attempt before it (#4829).

Divergence from the original, by design:

* **JS-heap check** (old ``performance.test.js`` PERF-03, ``performance.memory``
  under 500 MB) is **dropped**: it relied on ``browser.execute`` to read a
  Chromium-only DevTools metric, which the cross-platform bridge has no verb for
  (and which was already skipped on non-Chromium engines). A heap/metrics bridge
  command would be the way to restore it — surfaced back to #800.
"""

from __future__ import annotations

import time
from typing import Any

import pytest

from termihub_harness import SystemTest, TabsUi, TerminalUi, timing

pytestmark = pytest.mark.integration

#: termiHub's documented design target for simultaneous local terminals.
TARGET_TERMINALS = 40

#: Latency ceilings (seconds) mirrored from the original WebdriverIO thresholds.
SWITCH_LATENCY_BUDGET = 2.0
NEW_TERMINAL_BUDGET = 5.0

#: Live WebGL contexts the terminal pool may hold at once
#: (``DEFAULT_WEBGL_CONTEXT_CAPACITY`` in ``src/components/Terminal/webglRenderer.ts``,
#: kept below the engines' cap of 16 so they never force-lose a context).
WEBGL_CONTEXT_CAPACITY = 12


class TestPerformance(TerminalUi, TabsUi, SystemTest):
    """One app; PERF-01 builds the 40 terminals, PERF-04 tears them down."""

    def reset_before_rerun(self) -> None:
        # Close what the failed attempt left open, so the rerun starts empty.
        self.reset_tabs(timeout=60.0)

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
        leftover = self.tab_ids()
        assert not leftover, f"PERF-01 must start with no tabs, found {leftover}"
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

    def _assert_tab_painted(self, tab_id: str, label: str) -> dict[str, Any]:
        """The shown terminal has a sane grid and its renderer painted text."""
        m = self.driver.measure_terminal(tab_id)
        assert m["renderer"] in ("webgl", "dom"), f"{label}: renderer {m['renderer']!r}"
        assert m["container"]["width"] > 0 and m["container"]["height"] > 0, f"{label}: {m}"
        assert m["grid"]["cols"] >= 20 and m["grid"]["rows"] >= 5, f"{label}: grid {m['grid']}"
        if m["renderer"] == "webgl":
            canvas = m["webglCanvas"] or {}
            assert canvas.get("width", 0) > 0 and canvas.get("height", 0) > 0, f"{label}: {m}"
        else:
            assert any(row.strip() for row in m["domRows"] or []), f"{label}: blank DOM rows"
        return m

    def _echo_marker(self, tab_id: str, marker: str, label: str) -> int:
        """Echo ``marker`` in the tab and wait for it to render; return resends.

        The marker shows twice once rendered: the echoed command and its
        output. Input typed in the instant a tab is shown can be lost while the
        shell redraws for the re-fit (seen on macOS CI, #4931), so a marker that
        does not render within a few seconds is sent again (at most twice); the
        resend count is reported, the render itself must still happen.
        """
        for attempt in range(3):
            self.driver.terminal_input(f"echo {marker}\n", tab_id=tab_id)
            try:
                self.wait(
                    lambda: self.driver.read_terminal(tab_id).count(marker) >= 2,
                    timeout=5.0 if attempt < 2 else 20.0,
                    what=f"{label} to render its marker",
                )
                return attempt
            except AssertionError:
                if attempt == 2:
                    raise
        return 2

    def test_perf_03b_every_tab_renders_and_hidden_tabs_release_webgl(self):
        """MT-LOCAL-33: every one of (at least) twenty tabs renders text when
        shown, hidden tabs hold no WebGL context, and no context is ever lost."""
        self.ensure_terminals(TARGET_TERMINALS)
        ids = self.tab_ids()
        assert len(ids) >= 20

        renderers: dict[str, str] = {}
        resends = 0
        for index, tab_id in enumerate(ids):
            self.switch_to_tab(tab_id)
            self.wait(
                lambda tab_id=tab_id: (self.active_tab() or {}).get("id") == tab_id,
                what=f"tab #{index} to activate",
            )
            self.wait(
                lambda tab_id=tab_id: self.driver.read_terminal(tab_id).strip(),
                what=f"tab #{index} to show its prompt",
            )
            resends += self._echo_marker(tab_id, f"PERF05-{index:02d}", f"tab #{index}")
            renderers[tab_id] = self._assert_tab_painted(tab_id, f"tab #{index}")["renderer"]

        # After the sweep only the shown tab may keep a context (hidden → DOM),
        # and never more than the pool's capacity.
        shown = (self.active_tab() or {}).get("id")

        def live_webgl_tabs() -> list[str]:
            return [t for t in ids if self.driver.measure_terminal(t)["renderer"] == "webgl"]

        # The release on hide is not synchronous with the switch: give it a moment.
        try:
            live_webgl = self.wait(
                lambda: (lambda live: (live,) if set(live) <= {shown} else None)(
                    live_webgl_tabs()
                ),
                timeout=10.0,
                what="hidden tabs to release their WebGL contexts",
            )[0]
        except AssertionError:
            live_webgl = live_webgl_tabs()
        log = self.driver.read_frontend_log("renderer ")
        lost = self.driver.read_frontend_log("webgl context lost")
        used_webgl = sorted({r for r in renderers.values()}) == ["webgl"] or any(
            "renderer webgl (visible)" in e["message"] for e in log
        )
        print(
            f"\n[termihub-measure] perf-05 tabs={len(ids)} "
            f"renderers_when_shown={sorted(set(renderers.values()))} "
            f"live_webgl_after={len(live_webgl)} renderer_log_entries={len(log)} "
            f"context_lost={len(lost)} marker_resends={resends}"
        )
        timing.record("measure:perf-05:marker_resends", resends, 0)
        timing.record("measure:perf-05:live_webgl_after", len(live_webgl), 1)
        timing.record("measure:perf-05:context_lost", len(lost), 0)
        assert not lost, f"WebGL context lost: {[e['message'] for e in lost]}"
        assert len(live_webgl) <= WEBGL_CONTEXT_CAPACITY, live_webgl
        assert set(live_webgl) <= {shown}, (
            f"hidden tabs still hold a WebGL context: {sorted(set(live_webgl) - {shown})}"
        )
        if used_webgl:
            messages = [e["message"] for e in log]
            assert any("renderer webgl (visible)" in m for m in messages), messages[-20:]
            assert any("renderer dom (hidden)" in m for m in messages), messages[-20:]

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
