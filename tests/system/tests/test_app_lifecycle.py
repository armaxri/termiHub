"""The review-gate lifecycle suite: drive the real app, then kill and restart it.

Proves the concept end-to-end on the built app: write a command into a terminal
(``terminalInput``, #818), read the xterm buffer back, then kill and restart the
app, re-acquiring the bridge (#817). Built on :class:`SystemTest`, so the app is
launched once for the suite and the polling/terminal helpers are inherited.
"""

import pytest

from termihub_harness import SystemTest, TerminalUi

pytestmark = pytest.mark.integration


class TestAppLifecycle(TerminalUi, SystemTest):
    def test_terminal_input_and_read(self):
        self.ensure_terminal()
        marker = "HELLO_FROM_BRIDGE_4242"
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def test_restart_reacquires_bridge(self):
        # Kill + relaunch, then the suite's driver is re-acquired automatically.
        self.restart_app()
        assert isinstance(self.driver.get_state(), dict)
