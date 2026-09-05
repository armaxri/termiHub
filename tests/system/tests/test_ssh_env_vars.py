"""Environment-variable expansion in SSH (ported from infrastructure/ssh-env-vars.test.js).

The app expands ``${env:VAR}`` in connection fields at connect time but stores
the literal token. These tests assert the literal is persisted and that
connecting (with a resolvable or undefined variable) never hangs or crashes.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SSH_PASSWORD_PORT,
    SystemTest,
    unique_name,
)

pytestmark = pytest.mark.integration

HOST = "127.0.0.1"


@pytest.mark.usefixtures("ssh_fixtures")
class TestSshEnvVars(ConnectionsUi, PasswordPromptUi, SystemTest):
    def test_resolves_env_user_in_username(self):
        self._run("ssh-env-user", "${env:USER}")

    def test_undefined_env_var_does_not_crash(self):
        self._run("ssh-env-undef", "${env:NONEXISTENT}")

    def _run(self, prefix: str, username: str) -> None:
        name = unique_name(prefix)
        # Save & Connect: the literal token is saved; expansion happens at connect.
        self.create_ssh_connection(
            name,
            host=HOST,
            port=SSH_PASSWORD_PORT,
            username=username,
            connect=True,
        )
        # connections is region-authoritative since the Phase-5 reducer removal:
        # read the connections projection region (ConnectionsView twin,
        # {"folders": [...], "connections": [...]}) via the find_connection lookup
        # instead of the removed get_state("connections") slice (#2626).
        saved = self.wait(lambda: self.find_connection(name), what="connection to load")
        assert saved is not None
        # The literal ${env:…} token is preserved in the stored config (PR #68).
        assert "${env:" in str(saved.get("config", {}))
        # Connecting must not hang/crash; clear any prompt and assert responsive.
        if self.password_prompt_open():
            self.cancel_password_prompt()
        assert isinstance(self.driver.get_state(), dict)
