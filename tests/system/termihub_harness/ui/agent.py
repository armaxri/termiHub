"""Remote-agent flows (issue #974, port of ``infrastructure/remote-agent.test.js``).

``AgentUi`` drives the **Remote Agents** subsystem: creating a remote-agent
definition via the experimental Remote Agents sidebar group, the agent
context-menu (connect / setup), the connection-error feedback dialog a failed
connect raises, and the agent-setup wizard.

Remote agents are a distinct entity from regular connections — they live in the
``remoteAgents`` store (not ``connections``), are created through the dedicated
**New Remote Agent** (`+`) button (the connection editor no longer offers a
"remote" type), and render as ``agent-node-<id>`` rows whose context menu is
triggered from the ``agent-header-<id>`` child. The group is gated behind
experimental features, so suites also mix in
:class:`~termihub_harness.ui.SettingsUi` and
:class:`~termihub_harness.ui.SidebarUi`; the connect/setup flows raise the shared
password prompt, so :class:`~termihub_harness.ui.PasswordPromptUi` too.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from .base import HarnessMixin


class AgentUi(HarnessMixin):
    """Create remote agents and drive their menu, error dialog, and setup wizard."""

    if TYPE_CHECKING:  # borrowed: enable_experimental_features from SettingsUi,
        # switch_to_connections_sidebar from SidebarUi (suites mix both in)
        def enable_experimental_features(self) -> None: ...
        def switch_to_connections_sidebar(self) -> None: ...

    NEW_AGENT = "connection-list-new-agent"
    EDITOR_NAME = "connection-editor-name-input"
    EDITOR_SAVE = "connection-editor-save"

    CTX_CONNECT = "context-agent-connect"
    CTX_SETUP = "context-agent-setup"

    ERROR_TITLE = "connection-error-title"
    ERROR_SETUP_AGENT = "connection-error-setup-agent"
    ERROR_DETAILS = "connection-error-details"
    ERROR_CLOSE = "connection-error-close"

    SETUP_CANCEL = "agent-setup-cancel"
    SETUP_REMOTE_PATH = "agent-setup-remote-path"
    SETUP_ARCH = "agent-setup-arch-select"

    # ── lookups ─────────────────────────────────────────────────────────────────
    def remote_agents(self) -> list[dict[str, Any]]:
        value = self.driver.get_state("remoteAgents")
        return [a for a in value if isinstance(a, dict)] if isinstance(value, list) else []

    def find_agent(self, name: str) -> Optional[dict[str, Any]]:
        return next((a for a in self.remote_agents() if a.get("name") == name), None)

    def require_agent(self, name: str) -> dict[str, Any]:
        return self.wait(lambda: self.find_agent(name), what=f"remote agent {name!r}")

    def agent_header_testid(self, agent_id: str) -> str:
        """The context-menu trigger element for an agent row (the header, not the node)."""
        return f"agent-header-{agent_id}"

    # ── create ──────────────────────────────────────────────────────────────────
    def open_agents_sidebar(self) -> None:
        """Reveal the experimental Remote Agents group in the connections sidebar."""
        self.enable_experimental_features()
        self.switch_to_connections_sidebar()
        self.wait(lambda: self.driver.exists(self.NEW_AGENT), what="the New Remote Agent button")

    def create_remote_agent(
        self,
        name: str,
        *,
        host: str,
        port: int,
        username: str,
        auth_method: str = "password",
    ) -> dict[str, Any]:
        """Create a remote-agent definition via the New Remote Agent editor.

        The agent editor has no connection-type select (the type is fixed); it
        renders the same ``field-host`` / ``field-port`` / ``field-username`` /
        ``field-authMethod`` fields as SSH. Returns the saved agent.
        """
        self.open_agents_sidebar()
        self.driver.click(self.NEW_AGENT)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME), what="the agent editor")
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.type("field-host", str(host))
        self.driver.type("field-port", str(port))
        self.driver.type("field-username", username)
        if auth_method:
            self.driver.select("field-authMethod", auth_method)
        self.driver.click(self.EDITOR_SAVE)
        return self.require_agent(name)

    # ── context menu ────────────────────────────────────────────────────────────
    def open_agent_menu(self, name: str) -> None:
        """Right-click an agent by name and wait for its context menu to mount.

        The agent id is re-resolved by name on every poll (a save reloads the
        store), and the context menu is dispatched on the ``agent-header`` element
        — the actual ``ContextMenu.Trigger`` — only once it is in the DOM.
        """

        def menu_open() -> bool:
            agent = self.find_agent(name)
            if agent is None:
                return False
            header = self.agent_header_testid(agent["id"])
            if not self.driver.exists(header):
                return False
            self.driver.context_menu(header)
            return self.driver.exists(self.CTX_CONNECT)

        self.wait(menu_open, what=f"the {name!r} agent context menu")

    def agent_menu_action(self, name: str, action_test_id: str) -> None:
        """Right-click an agent by name and click a context-menu action."""
        self.open_agent_menu(name)
        self.driver.click(action_test_id)

    def connect_agent(self, name: str) -> None:
        """Trigger a connect on an agent via its context menu."""
        self.agent_menu_action(name, self.CTX_CONNECT)

    def open_agent_setup(self, name: str) -> None:
        """Open the agent-setup wizard via the agent's context menu."""
        self.agent_menu_action(name, self.CTX_SETUP)

    # ── connection-error dialog ─────────────────────────────────────────────────
    def connection_error_present(self) -> bool:
        return self.driver.exists(self.ERROR_TITLE)

    def dismiss_connection_error(self) -> None:
        """Wait for the connection-error dialog, click Close, and wait for it to go."""
        self.wait(self.connection_error_present, what="the connection-error dialog")
        self.driver.click(self.ERROR_CLOSE)
        self.wait(
            lambda: not self.connection_error_present(),
            what="the connection-error dialog to close",
        )

    def dismiss_connection_error_if_present(self) -> None:
        """Close the connection-error dialog if it happens to be open (for teardown).

        Unlike :meth:`dismiss_connection_error`, never waits for the dialog — a
        no-op when none is showing, so it is safe in an unconditional cleanup.
        """
        if self.connection_error_present():
            self.driver.click(self.ERROR_CLOSE)

    # ── setup wizard ────────────────────────────────────────────────────────────
    def setup_ready(self) -> bool:
        """Whether the setup wizard finished arch detection and shows its form.

        Checks a *form-phase* field (the arch select) rather than the Submit/Cancel
        buttons — those render in every phase (detecting / error / ready), so they
        are not a readiness signal; the form fields appear only once detection
        succeeds.
        """
        return self.driver.exists(self.SETUP_ARCH)

    def cancel_agent_setup(self) -> None:
        """Cancel the agent-setup dialog and wait for it to close."""
        self.driver.click(self.SETUP_CANCEL)
        self.wait(
            lambda: not self.driver.exists(self.SETUP_CANCEL),
            what="the agent-setup dialog to close",
        )
