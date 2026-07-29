"""Content-Security-Policy guard (#2059).

CSP is only enforced in a **production** WebView build (never in ``dev``), so a
policy that blocks something the app needs — the class of regression that nearly
shipped in #2048 — is invisible until a real build is driven. This suite closes
that gap: it launches the built app under the enforced CSP, confirms the app
boots and a terminal actually renders (output flows back), and asserts the
frontend saw **zero** CSP violations.

Runs on every non-macOS integration leg (Linux/Windows). The bridge itself needs
a loopback ``ws://`` that the production CSP forbids; the test build re-adds only
that one allowance via ``src-tauri/tauri.test.conf.json`` (see the build steps in
``scripts/test-system-py.sh`` / ``system-integration.yml``). Every other,
rendering-relevant directive is identical to production, so a broken shipped CSP
still fails here.
"""

import pytest

from termihub_harness import SystemTest, TerminalUi

pytestmark = pytest.mark.integration

# Must match CSP_VIOLATION_SINK_TESTID in src/security/cspViolationReporter.ts.
CSP_SINK = "csp-violations"


class TestContentSecurityPolicy(TerminalUi, SystemTest):
    def test_app_boots_and_terminal_renders_under_csp(self):
        # A terminal that opens, runs a command, and echoes output back proves
        # scripts executed and IPC worked under the enforced CSP — i.e. the
        # policy did not block the app's own bundle, xterm, or the IPC transport.
        self.ensure_terminal()
        self.run_command("echo csp-render-marker")
        assert "csp-render-marker" in self.wait_for_output("csp-render-marker")

    def test_no_csp_violations_were_reported(self):
        # The reporter installs its sink before React mounts, so its presence
        # confirms the frontend booted far enough to run main.tsx.
        assert self.driver.exists(CSP_SINK), (
            "CSP violation sink missing — the frontend did not boot, or the "
            "reporter was removed from main.tsx"
        )
        count = self.driver.get_attribute(CSP_SINK, "data-count")
        details = self.driver.get_text(CSP_SINK)
        assert count == "0", f"the shipped CSP blocked {count} resource(s):\n{details}"
