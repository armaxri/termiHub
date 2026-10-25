"""Network Tools — live Traceroute through a multi-hop Docker chain (#4964).

The ``traceroute_fixtures`` chain (compose profile ``traceroute``) puts two
routing containers between this host and a target, so a trace has exactly
three deterministic hops: router1, router2, then the target itself. See
``tests/docker/traceroute-hop/entrypoint.sh`` for the topology.

No privilege is involved on either side: the host reaches the target through
router1's proxy ARP (no host route), and on Linux the app traces without
``CAP_NET_RAW`` via ``IP_RECVERR`` on its UDP probe socket. The suite skips
off Linux (the daemon runs in a VM there, so the host is not on the bridge).

Covers MT-NET-16, retired from the guided-manual suite.
"""

from __future__ import annotations

import re

import pytest

from termihub_harness import (
    NetworkToolsUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TracerouteHops,
)

pytestmark = pytest.mark.integration

#: An RTT cell as the panel formats it (``0.1ms``, ``12.3ms``).
_RTT = re.compile(r"\d+\.\dms")
#: Generous: three hops answer in milliseconds; a probe that is lost costs 3 s.
_TRACE_TIMEOUT = 60.0


class TestTracerouteLive(NetworkToolsUi, SidebarUi, SettingsUi, TabsUi, SystemTest):
    """One app; the test traces the fixture's target and reads every hop row."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def _cell(self, row: int, column: str) -> str:
        return (self.driver.get_text(f"traceroute-hop-{row}-{column}") or "").strip()

    def test_traceroute_hops_stream_in_and_complete(self, traceroute_fixtures: TracerouteHops):
        """MT-NET-16: hop rows stream in with hop number, address and three RTT
        cells, and the trace completes at the target."""
        hops = traceroute_fixtures.expected
        self.open_tool_panel("traceroute", "traceroute-panel")
        self.driver.type("traceroute-host", traceroute_fixtures.target)
        self.driver.click("traceroute-run")

        self.wait(lambda: self.driver.exists("traceroute-hop-0"), what="the first hop row")
        self.wait(
            lambda: "Trace complete" in (self.driver.get_text("traceroute-footer") or ""),
            timeout=_TRACE_TIMEOUT,
            what="the traceroute to complete",
        )

        rows = [
            {key: self._cell(i, key) for key in ("hop", "ip", "rtt1", "rtt2", "rtt3")}
            for i in range(len(hops))
        ]
        for i, (row, address) in enumerate(zip(rows, hops)):
            assert row["hop"] == str(i + 1), rows
            assert row["ip"] == address, rows
            for key in ("rtt1", "rtt2", "rtt3"):
                assert _RTT.fullmatch(row[key]), (key, rows)
        # It stopped at the target: no fourth row, and the footer counts three.
        assert not self.driver.exists(f"traceroute-hop-{len(hops)}"), rows
        assert f"{len(hops)} hops" in self.driver.get_text("traceroute-footer")
