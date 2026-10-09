"""SSH jump-host reconnect system test (MT-SSH-44, issue #3688).

Two SSH tabs reach the internal ``ssh-jumphost-target`` through the same inline
bastion hop, so the backend's process-wide gateway pool serves both from **one**
gateway session on the bastion. The test stops the bastion container, which drops
both tabs, starts it again, and asserts that both tabs reconnect on their own
(Auto-Reconnect is on by default) and that the re-established chains share one
new gateway session — counted on the bastion itself by :class:`BastionControl`.

The pooling and eviction rules underneath are also covered headlessly against the
same fixture by ``core/tests/ssh_advanced.rs`` (SSH-JUMP-03 and SSH-JUMP-07).
"""

from __future__ import annotations

import time
from typing import Any, Optional

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_BASTION_PORT,
    SSH_JUMP_TARGET_HOST,
    SSH_JUMP_TARGET_PORT,
    SSH_KEY_PATH,
    BastionControl,
    BridgeError,
    ConnectionsUi,
    ComposeFixtureFailed,
    ContainerRuntimeUnavailable,
    JumpHostUi,
    PasswordPromptUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: Projection region of the session lifecycle (twin of ``SESSION_LIFECYCLE_REGION``
#: in ``src/store/sessionBridge.ts``); its view is ``{"sessions": {<tabId>: …}}``.
SESSION_LIFECYCLE_REGION = "session-lifecycle"
#: Budget for a jump-host tab to connect through a fresh app's host-key prompts.
CONNECT_TIMEOUT = 90.0
#: Budget for both tabs to notice the bastion going away.
DROP_TIMEOUT = 60.0
#: Budget for the auto-reconnect loop to re-establish a tab once the bastion is
#: back. The loop backs off up to 30 s between attempts (``RECONNECT_POLICY``).
RECONNECT_TIMEOUT = 150.0


@pytest.mark.usefixtures("ssh_bastion_fixtures")
class TestSshJumpHostReconnect(
    JumpHostUi, TerminalUi, TabsUi, ConnectionsUi, PasswordPromptUi, SystemTest
):
    """MT-SSH-44: both tabs reconnect through one new shared gateway session."""

    # Live SSH connects through a two-step chain; give bridge commands the
    # live-connect budget (#2460).
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def _session(self, tab_id: str) -> Optional[dict[str, Any]]:
        sessions = self.projection_region_cache(SESSION_LIFECYCLE_REGION).get("sessions")
        life = sessions.get(tab_id) if isinstance(sessions, dict) else None
        return life if isinstance(life, dict) else None

    def _status(self, tab_id: str) -> Optional[str]:
        life = self._session(tab_id)
        return life.get("status") if life else None

    def _open_jump_tab(self, name: str) -> str:
        """Create + Save & Connect a jump-host connection; return its tab id."""
        self.create_jump_host_connection(
            name,
            target_host=SSH_JUMP_TARGET_HOST,
            target_port=SSH_JUMP_TARGET_PORT,
            bastion_port=SSH_BASTION_PORT,
            key_path=SSH_KEY_PATH,
            connect=True,
        )
        # A fresh app instance trusts neither the bastion nor the target yet.
        self.accept_jump_host_key_prompts()
        tab = self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")
        tab_id = tab["id"]
        self.wait(
            lambda: self._status(tab_id) == "connected",
            timeout=CONNECT_TIMEOUT,
            what=f"the {name!r} tab to connect through the bastion",
        )
        return tab_id

    def _echo_until_live(self, tab_id: str, marker: str, *, timeout: float) -> None:
        """Type ``echo <marker>`` into the tab until its output shows up.

        The marker is split in the typed command, so only the command's output
        (never the echoed command line) satisfies the wait. Re-typing covers
        input that landed while the session was still being re-attached.
        """
        head, tail = marker[: len(marker) // 2], marker[len(marker) // 2 :]

        def live() -> bool:
            if marker in self.driver.read_terminal(tab_id):
                return True
            try:
                self.driver.terminal_input(f"echo {head}''{tail}", tab_id=tab_id)
            except BridgeError:
                pass  # session not attached yet — retry on the next poll
            return False

        self.wait(live, timeout=timeout, interval=2.0, what=f"{marker!r} in tab {tab_id}")

    def _wait_for_gateway_sessions(self, bastion: BastionControl, expected: int, why: str) -> None:
        self.wait(
            lambda: bastion.gateway_sessions() == expected,
            timeout=30.0,
            what=f"{expected} gateway session(s) on the bastion ({why})",
        )

    def test_both_tabs_reconnect_through_one_new_gateway(self):
        if not SSH_KEY_PATH.exists():
            pytest.skip(f"SSH key fixture missing: {SSH_KEY_PATH}")
        bastion = BastionControl()
        if not bastion.available:
            pytest.skip("no container runtime to stop/start the bastion")
        try:
            # Two tabs through the same bastion share one gateway session.
            tab_a = self._open_jump_tab(unique_name("jump-a"))
            tab_b = self._open_jump_tab(unique_name("jump-b"))
            self._echo_until_live(tab_a, "TH_JUMP_A_BEFORE_4417", timeout=CONNECT_TIMEOUT)
            self._echo_until_live(tab_b, "TH_JUMP_B_BEFORE_4417", timeout=CONNECT_TIMEOUT)
            self._wait_for_gateway_sessions(bastion, 1, "two tabs share the gateway")

            # Drop the bastion: both tabs lose their chain.
            bastion.stop()
            for tab_id in (tab_a, tab_b):
                self.wait(
                    lambda tab_id=tab_id: self._status(tab_id) not in (None, "connected"),
                    timeout=DROP_TIMEOUT,
                    what=f"tab {tab_id} to notice the bastion going down",
                )

            # Restore it: the auto-reconnect loops re-establish both chains.
            bastion.restore()
            for tab_id in (tab_a, tab_b):
                self.wait(
                    lambda tab_id=tab_id: self._status(tab_id) == "connected",
                    timeout=RECONNECT_TIMEOUT,
                    what=f"tab {tab_id} to reconnect through the restarted bastion",
                )
            self._echo_until_live(tab_a, "TH_JUMP_A_AFTER_4417", timeout=CONNECT_TIMEOUT)
            self._echo_until_live(tab_b, "TH_JUMP_B_AFTER_4417", timeout=CONNECT_TIMEOUT)

            # One new gateway carries both reconnected tabs — not one per tab.
            self._wait_for_gateway_sessions(bastion, 1, "both tabs reconnected")
            time.sleep(3)
            assert bastion.gateway_sessions() == 1, (
                "the reconnected tabs must share one gateway session on the bastion"
            )
        except ContainerRuntimeUnavailable as exc:
            pytest.skip(f"cannot control the bastion container: {exc}")
        finally:
            # Never leave the shared bastion stopped for the suites after this one.
            try:
                bastion.restore()
            except (ContainerRuntimeUnavailable, ComposeFixtureFailed) as exc:
                print(f"[jump-host] could not restore {bastion.container}: {exc}")
            self.close_all_tabs()
