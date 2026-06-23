"""A suite whose tests share one app instance — the common case.

Demonstrates the per-suite model: the app is launched once for the class, and
each test runs against that same instance in order (no relaunch between tests).
A different suite gets its own clean app.
"""

import pytest

from termihub_harness import SystemTest, TerminalUi

pytestmark = pytest.mark.integration


class TestTerminalBasics(TerminalUi, SystemTest):
    def test_echo_runs(self):
        self.ensure_terminal()
        self.delay4user(1, reason="terminal opened")  # no-op unless --delay4user
        self.run_command("echo basics-echo-marker")
        assert "basics-echo-marker" in self.wait_for_output("basics-echo-marker")
        self.delay4user(2, reason="echo output visible")

    def test_pwd_runs_in_the_same_instance(self):
        # No new app launch — reuses the instance (and terminal) from above.
        self.ensure_terminal()  # idempotent: keeps the existing terminal
        self.run_command("pwd")
        assert "/" in self.wait_for_output("/")
        self.delay4user(2, reason="pwd output visible")

    def test_app_state_is_introspectable(self):
        state = self.driver.get_state()
        assert isinstance(state, dict)
