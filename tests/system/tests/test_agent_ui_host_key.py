"""Machinery test: waiting for an agent to connect answers the host-key prompt.

The 2026-10-06 nightly stalled every live-agent suite on the SSH host-key trust
prompt (#1959), which ``wait_agent_connected`` never answered. Runs in the fast
``not integration`` group against a scripted driver (no app).
"""

from __future__ import annotations

import pytest

from termihub_harness.ui.agent import AgentUi


class _ScriptedDriver:
    """The host-key prompt is up until "Accept for host" is clicked."""

    def __init__(self, *, prompt: bool) -> None:
        self.prompt = prompt
        self.clicks: list[str] = []

    def exists(self, test_id: str) -> bool:
        return test_id == AgentUi.HOSTKEY_PROMPT and self.prompt

    def click(self, test_id: str) -> None:
        self.clicks.append(test_id)
        if test_id == AgentUi.HOSTKEY_ACCEPT_REMEMBER:
            self.prompt = False


class _Agents(AgentUi):
    """``AgentUi`` with a scripted driver, store, and an immediate ``wait``."""

    def __init__(self, driver: _ScriptedDriver) -> None:
        self.driver = driver  # type: ignore[assignment]

    def find_agent(self, name):
        # Connected only once the handshake can proceed past the prompt.
        state = "connecting" if self.driver.prompt else "connected"
        return {"name": name, "connectionState": state}

    def wait(self, predicate, *, timeout=0.0, interval=0.0, what=""):
        for _ in range(10):
            result = predicate()
            if result:
                return result
        raise AssertionError(f"timed out waiting for {what}")


def test_accepts_the_host_key_prompt_then_sees_the_agent_connected():
    driver = _ScriptedDriver(prompt=True)
    agent = _Agents(driver).wait_agent_connected("a")
    assert agent["connectionState"] == "connected"
    assert driver.clicks == [AgentUi.HOSTKEY_ACCEPT_REMEMBER]


def test_no_prompt_means_no_click():
    driver = _ScriptedDriver(prompt=False)
    _Agents(driver).wait_agent_connected("a")
    assert driver.clicks == []


def test_opting_out_leaves_the_prompt_alone():
    driver = _ScriptedDriver(prompt=True)
    with pytest.raises(AssertionError, match="connected state"):
        _Agents(driver).wait_agent_connected("a", accept_host_keys=False)
    assert driver.clicks == []
