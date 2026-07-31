"""Frontend-plugin execution baseline under the enforced CSP (#2136).

This is the regression baseline for the plugin-sandbox work: it proves, in a
production-shaped build with the CSP enforced, that an **enabled frontend plugin
actually runs** — its protocol parser transforms terminal output and its
status-bar widget renders — and that doing so trips **zero** CSP violations.
That baseline could not be established before #2234 (no plugin ever reached
``active`` in a real build); with activation landed, it can, and it is the net
that lets the later PRs move frontend plugin execution into a Worker sandbox and
drop ``blob:`` from ``script-src`` without silently breaking the feature.

The suite seeds a real plugin (a parser + a status-bar widget from one
``frontend/index.js``) onto disk in the app's isolated config dir, restarts so
the manager activates it, then drives the experimental frontend-plugin gate
(``frontendPluginsEnabled``, default-off) exactly as a user would — proving the
gate is what starts (and stops) execution.

Runs on the integration legs only (real built app; not per-PR CI), like
``test_csp.py`` — the CSP is only enforced in a production WebView build, so the
"plugin JS runs with zero CSP violations" claim is only meaningful here. The
test build re-adds only the loopback ``ws://`` bridge allowance via
``src-tauri/tauri.test.conf.json``; ``script-src`` still carries the production
policy.
"""

import pytest

from termihub_harness import PluginsUi, SettingsUi, SystemTest, TerminalUi

pytestmark = pytest.mark.integration

# Must match CSP_VIOLATION_SINK_TESTID in src/security/cspViolationReporter.ts.
CSP_SINK = "csp-violations"


class TestFrontendPluginBaseline(PluginsUi, SettingsUi, TerminalUi, SystemTest):
    def test_seeded_plugin_activates_but_stays_dormant_while_gated(self):
        # Seed the plugin on disk and restart so the manager scans it. Post-#2234
        # an enabled, compatible frontend-only plugin reaches `active`.
        self.seed_sandbox_plugin()
        self.wait(
            lambda: self.sandbox_plugin_state() == "active",
            what="the seeded plugin to reach the active state",
        )

        # The experimental gate is default-off, so no plugin JS is injected yet:
        # the widget never mounts and the parser never registers. This is the
        # dormant baseline the gate must flip.
        assert not self.frontend_plugin_gate_enabled()
        assert not self.driver.exists(self.SANDBOX_WIDGET_TESTID), (
            "the plugin widget rendered while the frontend-plugin gate was off — "
            "plugin JS executed without the opt-in"
        )

    def test_enabling_the_gate_executes_the_parser_and_renders_the_widget(self):
        # Flipping the gate re-runs reconcile, which injects the plugin's JS. Both
        # extension points come from one entry point, so a rendered widget proves
        # the script executed; a transformed line proves the parser is live.
        self.enable_frontend_plugin_gate()

        self.wait(
            lambda: self.driver.exists(self.SANDBOX_WIDGET_TESTID),
            what="the plugin status-bar widget to render",
        )

        self.ensure_terminal()
        # The shell echoes the command and its output; the parser rewrites the
        # sentinel wherever it appears, so the transformed token proves transform()
        # ran over real terminal output.
        self.run_command(f"echo {self.PARSER_INPUT_TOKEN}")
        output = self.wait_for_output(self.PARSER_OUTPUT_TOKEN)
        assert self.PARSER_OUTPUT_TOKEN in output

    def test_no_csp_violations_with_the_frontend_plugin_active(self):
        # The plugin JS loads from a blob URL and its widget mounts DOM into the
        # main document; neither may trip the enforced CSP. The reporter's sink is
        # installed before React mounts, so its presence also confirms the app booted.
        assert self.driver.exists(CSP_SINK), (
            "CSP violation sink missing — the frontend did not boot, or the "
            "reporter was removed from main.tsx"
        )
        count = self.driver.get_attribute(CSP_SINK, "data-count")
        details = self.driver.get_text(CSP_SINK)
        assert count == "0", (
            f"the enforced CSP blocked {count} resource(s) with a frontend plugin "
            f"active:\n{details}"
        )

    def test_disabling_the_gate_tears_down_plugin_execution(self):
        # Turning the gate back off unloads the injected script and unregisters the
        # plugin's extensions, so the widget unmounts — execution is fully reversible.
        self.disable_frontend_plugin_gate()
        self.wait(
            lambda: not self.driver.exists(self.SANDBOX_WIDGET_TESTID),
            what="the plugin widget to unmount after disabling the gate",
        )
