"""End-to-end guard that pressing Enter submits a command (regression #827).

Background: the line-ending feature (#791) originally defaulted to LF, which
rewrote the Enter keystroke (xterm sends ``\\r``) to ``\\n`` at the backend
``send_input`` choke point. Windows ConPTY and macOS shells do not treat a bare
``\\n`` as "submit", so Enter only inserted a newline and the command never ran.
The fix defaults to CR (#827).

``run_command`` drives the same ``send_input`` choke point as interactive Enter
(it appends a line break that the backend normalizes to the session's configured
line ending), so this test exercises the fixed path against the real built app.

PLATFORM CAVEAT — read before trusting a green run:
    This only *fails* without the fix on **macOS and Windows**. On **Linux** the
    shell/readline accepts a bare ``\\n`` as "submit", so the command runs even
    with the old LF default — i.e. a green Linux/CI run does NOT prove the
    regression is gone. The platform-independent red-green guard is the Rust
    unit test ``session::line_ending::bare_enter_stays_cr_by_default``; this
    suite is the end-to-end confirmation, and a real guard when run on macOS or
    Windows (the platforms where the bug actually showed).
"""

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration


class TestEnterSubmitsCommand(SystemTest):
    def test_enter_submits_command_default_line_ending(self):
        self.ensure_terminal()
        self.delay4user(1, reason="terminal opened")  # no-op unless --delay4user
        # Default line ending (CR after #827). run_command appends the line break
        # that send_input normalizes — the same choke point as pressing Enter.
        self.run_command("echo enter-submit-marker")
        assert "enter-submit-marker" in self.wait_for_output("enter-submit-marker")
        self.delay4user(2, reason="command output visible")
