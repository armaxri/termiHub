"""SSH agent-auth error feedback (ported from infrastructure/ssh-agent-error.test.js).

The original selected an ``agent`` auth method and asserted the app failed
gracefully when no SSH agent was running. The current connection schema exposes
only ``key`` and ``password`` auth methods (core/src/connection/schema.rs), so
agent auth cannot be configured through the editor that the bridge drives — the
scenario is not reachable here.
"""

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.skip(reason="agent auth is not a selectable authMethod option (SSH-AGENT-ERROR)")
def test_agent_auth_shows_helpful_error_when_no_agent():
    ...
