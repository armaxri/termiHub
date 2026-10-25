"""SSH agent auth connects through a private ssh-agent (MT-SSH-07, #4953).

Connects with the ``agent`` auth method (no password, no key path) and asserts a
terminal comes up. This used to be a guided-manual test that skipped unless the
operator's own ssh-agent already held the fixture key, so it graded nothing on CI.

Now the suite owns the agent: :class:`~termihub_harness.PrivateSshAgent` starts
``ssh-agent -D -a <tmp sock>``, loads a 0600 copy of the key the SSH server
authorizes, and the suite's app is launched with that socket as
``SSH_AUTH_SOCK`` (the :meth:`SystemTest.extra_app_env` hook). The agent is
killed when the suite ends. The developer's own agent and keys are never read,
changed or offered to the server.

The SSH server per platform:

- **Linux:** the ``ssh-keys`` container (key-only, port 2203) with the committed
  ``tests/fixtures/ssh-keys/ed25519`` key.
- **macOS:** a throwaway loopback ``sshd`` (:class:`LocalAgentSshd`) with its own
  throwaway client key, because the hosted macOS runners have no container
  runtime (the same carve-out as ``test_ssh_tunnels.py``).
- **Windows:** skipped. The app's Windows agent client only connects to the
  system OpenSSH agent pipe, which is the developer's own agent; a test may not
  load keys into it.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_HOST,
    SSH_KEY_PATH,
    SSH_KEYS_PORT,
    SSH_USERNAME,
    ConnectionsUi,
    PasswordPromptUi,
    PrivateSshAgent,
    PrivateSshAgentUnavailable,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.local_agent import LocalAgentSshd, LocalAgentUnavailable

pytestmark = pytest.mark.integration

#: Skip reason on Windows (allowlisted for ``bulk-windows``).
WINDOWS_SKIP = (
    "SSH agent auth on Windows uses the system OpenSSH agent pipe, "
    "which a test must not load keys into"
)


@dataclass(frozen=True)
class AgentAuthTarget:
    """The SSH server the agent-auth test connects to, and the agent's env."""

    port: int
    username: str
    app_env: dict[str, str]


@pytest.fixture(scope="module")
def agent_auth_target(request):
    """A private ssh-agent holding the key the target sshd authorizes.

    Module-scoped so the suite's :meth:`extra_app_env` can resolve it before the
    app launches; torn down (agent killed, sshd stopped) after the app exits.
    """
    if os.name == "nt":
        pytest.skip(WINDOWS_SKIP)
    sshd = None
    try:
        if sys.platform == "darwin":
            sshd = LocalAgentSshd(require_agent=False)
            sshd.start()
            port, username, key = sshd.port, sshd.username, Path(sshd.client_key_path)
        else:
            request.getfixturevalue("ssh_fixtures")
            port, username, key = SSH_KEYS_PORT, SSH_USERNAME, SSH_KEY_PATH
    except LocalAgentUnavailable as exc:
        pytest.skip(f"native loopback sshd unavailable: {exc}")
    try:
        agent = PrivateSshAgent()
    except PrivateSshAgentUnavailable as exc:
        if sshd is not None:
            sshd.cleanup()
        pytest.skip(f"private ssh-agent unavailable: {exc}")
    try:
        agent.add_key(key)
        assert agent.has_key(key), "the private ssh-agent does not list the loaded key"
        yield AgentAuthTarget(port, username, agent.app_env())
    finally:
        agent.close()
        if sshd is not None:
            sshd.cleanup()


class TestSshAgentAuth(TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest):
    """MT-SSH-07: agent auth connects with no password and no key path."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        target = request.getfixturevalue("agent_auth_target")
        cls.target = target
        return target.app_env

    def test_ssh_agent_auth_connects(self):
        """MT-SSH-07: an ``agent``-auth SSH connection opens a terminal.

        The app's only credential source is the private ssh-agent from
        ``agent_auth_target``, so a terminal proves the app asked the agent at
        ``SSH_AUTH_SOCK`` to sign the challenge. No password prompt may appear.
        """
        self.close_all_tabs()
        name = unique_name("agent-auth")
        self.create_ssh_connection(
            name,
            host=SSH_HOST,
            port=self.target.port,
            username=self.target.username,
            auth_method="agent",
            connect=True,
        )
        tab = self.wait(lambda: self.find_tab(name), what="the agent-auth tab")
        assert tab is not None
        assert not self.password_prompt_open(), "agent auth must not prompt for a password"
        # Agent auth needs no prompt; the session should establish on its own.
        assert self.wait(self.has_terminal, what="the agent-authenticated terminal")
