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

#: Projection region id for the agents domain (region-authoritative since #2409;
#: twin of the frontend ``AGENTS_REGION`` const). Its cache is the raw store
#: snapshot keyed ``agents`` / ``sessions`` / ``definitions`` / ``folders`` —
#: **not** the ``appStore``-named ``remoteAgents`` / ``agentSessions`` / … slices,
#: which no longer exist on the store.
AGENTS_REGION = "agents"


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
    CTX_DISCONNECT = "context-agent-disconnect"
    CTX_REFRESH = "context-agent-refresh"
    CTX_NEW_SHELL = "context-agent-new-shell"
    CTX_NEW_CONNECTION = "context-agent-new-connection"
    CTX_EDIT = "context-agent-edit"
    CTX_DELETE = "context-agent-delete"

    # Agent-definition editor (opened as a tab via "New Connection"): a saved
    # shell/serial connection under a connected agent, optionally persistent.
    DEF_EDITOR_NAME = "connection-editor-name-input"
    DEF_EDITOR_TYPE = "connection-editor-type-select"
    DEF_EDITOR_PERSISTENT = "connection-editor-persistent"
    DEF_EDITOR_SAVE = "connection-editor-save"

    # Per-definition persistent-session action buttons (id suffix is the def id).
    CTX_DEF_START_PERSISTENT = "context-agent-def-start-persistent"

    ERROR_TITLE = "connection-error-title"
    ERROR_SETUP_AGENT = "connection-error-setup-agent"
    ERROR_DETAILS = "connection-error-details"
    ERROR_CLOSE = "connection-error-close"

    SETUP_CANCEL = "agent-setup-cancel"
    SETUP_REMOTE_PATH = "agent-setup-remote-path"
    SETUP_ARCH = "agent-setup-arch-select"

    # Deferred-update banner (#1352), rendered under a *connected* agent's row.
    # The id suffix is the agent id. Apply Now's *deferred/busy* outcome is driven
    # live against the armed agent container in
    # tests/system/tests/test_agent_update_apply_now_live.py (#1520 / #1546); its
    # applied-immediately outcome stays unassertable live (the idle apply re-execs
    # before the RPC responds) and remains a Vitest case.
    UPDATE_BANNER = "agent-update-banner"
    UPDATE_BANNER_DISMISS = "agent-update-banner-dismiss"
    UPDATE_BANNER_APPLY = "agent-update-banner-apply"

    # ── lookups ─────────────────────────────────────────────────────────────────
    def remote_agents(self) -> list[dict[str, Any]]:
        # Region-authoritative (#2409): read the `agents` projection region, whose
        # raw cache lists the agents under the `agents` key (the old
        # get_state("remoteAgents") path no longer resolves — #2479).
        value = self.projection_region_cache(AGENTS_REGION).get("agents")
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
    def open_agent_menu(self, name: str, *, sentinel: Optional[str] = None) -> None:
        """Right-click an agent by name and wait for its context menu to mount.

        Delegates to :meth:`HarnessMixin.open_named_context_menu`: the agent id is
        re-resolved by name on every poll (a save reloads the store), and the
        right-click is dispatched on the ``agent-header`` element — the actual
        ``ContextMenu.Trigger`` — only once it is in the DOM.

        The menu renders a *different* item set by connection state, so the
        readiness ``sentinel`` differs too: the default ``context-agent-connect``
        exists only while **disconnected**; pass ``CTX_DISCONNECT`` to wait on the
        **connected** menu.
        """
        self.open_named_context_menu(
            resolve=lambda: self.find_agent(name),
            testid_for=self.agent_header_testid,
            sentinel=sentinel or self.CTX_CONNECT,
            what=f"the {name!r} agent context menu",
        )

    def agent_menu_action(
        self, name: str, action_test_id: str, *, sentinel: Optional[str] = None
    ) -> None:
        """Right-click an agent by name and click a context-menu action.

        ``sentinel`` selects which menu variant to wait for; it defaults to the
        clicked action itself, which is correct for actions that only appear in
        one state (e.g. Disconnect / New Shell Session on a connected agent).
        """
        self.open_agent_menu(name, sentinel=sentinel or action_test_id)
        self.driver.click(action_test_id)

    def connect_agent(self, name: str) -> None:
        """Trigger a connect on an agent via its context menu."""
        self.agent_menu_action(name, self.CTX_CONNECT)

    def disconnect_agent(self, name: str) -> None:
        """Trigger a disconnect on a connected agent via its context menu."""
        self.agent_menu_action(name, self.CTX_DISCONNECT)

    def open_agent_setup(self, name: str) -> None:
        """Open the agent-setup wizard via the agent's context menu."""
        self.agent_menu_action(name, self.CTX_SETUP)

    def new_shell_session(self, name: str) -> None:
        """Create a (non-persistent) shell session under a connected agent."""
        self.agent_menu_action(name, self.CTX_NEW_SHELL)

    # ── live-connection state ────────────────────────────────────────────────────
    def agent_connection_state(self, name: str) -> Optional[str]:
        """The ``connectionState`` of an agent (``connected`` / ``disconnected`` / …)."""
        agent = self.find_agent(name)
        return agent.get("connectionState") if agent else None

    def wait_agent_connected(self, name: str, *, timeout: float = 40.0) -> dict[str, Any]:
        """Wait until an agent reaches the ``connected`` state and return it.

        A live connect runs an SSH handshake and an agent handshake, so this is
        slower than a plain store update — hence the generous default timeout.
        """
        return self.wait(
            lambda: (
                agent
                if (agent := self.find_agent(name))
                and agent.get("connectionState") == "connected"
                else None
            ),
            what=f"agent {name!r} to reach the connected state",
            timeout=timeout,
        )

    def agent_available_shells(self, name: str) -> list[str]:
        """The shells the connected agent reported in its capabilities."""
        agent = self.find_agent(name) or {}
        capabilities = agent.get("capabilities") or {}
        shells = capabilities.get("availableShells")
        return [s for s in shells if isinstance(s, str)] if isinstance(shells, list) else []

    def _agent_keyed_dicts(self, region_key: str, agent_id: str) -> list[dict[str, Any]]:
        """The dict entries of a ``Record<agentId, list>`` map in the agents region.

        Region-authoritative (#2409): the per-agent lists live under the raw
        ``agents``-region keys (``sessions`` / ``definitions`` / ``folders``), not
        the old ``appStore`` slices, so this reads the region cache (#2479).
        """
        value = self.projection_region_cache(AGENTS_REGION).get(region_key)
        items = value.get(agent_id) if isinstance(value, dict) else None
        return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []

    # ── agent-side sessions ──────────────────────────────────────────────────────
    def agent_sessions(self, agent_id: str) -> list[dict[str, Any]]:
        """The live sessions the agent reports for ``agent_id`` (region ``sessions``)."""
        return self._agent_keyed_dicts("sessions", agent_id)

    # ── saved definitions + persistent sessions ─────────────────────────────────
    def agent_definitions(self, agent_id: str) -> list[dict[str, Any]]:
        """Saved connection definitions under ``agent_id`` (region ``definitions``)."""
        return self._agent_keyed_dicts("definitions", agent_id)

    def create_agent_definition(
        self, agent_name: str, def_name: str, *, persistent: bool = False
    ) -> dict[str, Any]:
        """Create a saved connection definition under a connected agent.

        Opens the agent-definition editor via "New Connection", keeps the default
        session type (the agent's first reported type — a shell on a Linux agent),
        optionally toggles the persistent switch, saves, and returns the saved
        definition once it lands in ``agentDefinitions``.
        """
        agent = self.require_agent(agent_name)
        self.agent_menu_action(agent_name, self.CTX_NEW_CONNECTION)
        self.wait(
            lambda: self.driver.exists(self.DEF_EDITOR_NAME), what="the agent-definition editor"
        )
        self.driver.type(self.DEF_EDITOR_NAME, def_name)
        if persistent:
            self.driver.click(self.DEF_EDITOR_PERSISTENT)
        self.driver.click(self.DEF_EDITOR_SAVE)
        return self.wait(
            lambda: next(
                (
                    d
                    for d in self.agent_definitions(agent["id"])
                    if d.get("name") == def_name
                ),
                None,
            ),
            what=f"the saved agent definition {def_name!r}",
        )

    def persistent_session_state(self, agent_id: str, def_id: str) -> Optional[str]:
        """The ``state`` of the persistent session for ``agent_id:def_id``, if any."""
        value = self.driver.get_state("persistentSessions")
        if not isinstance(value, dict):
            return None
        entry = value.get(f"{agent_id}:{def_id}")
        return entry.get("state") if isinstance(entry, dict) else None

    def start_persistent_session(self, def_id: str) -> None:
        """Start a persistent session via a definition's inline start button."""
        self.driver.click(f"persistent-start-{def_id}")

    def wait_persistent_running(
        self, agent_id: str, def_id: str, *, timeout: float = 40.0
    ) -> None:
        """Wait until the persistent session for ``agent_id:def_id`` is live.

        ``running`` (or ``attached`` once a tab attaches) is the backend-confirmed
        live state — the store only transitions there off the
        ``persistent-session-state-changed`` event, not synchronously on start.
        """
        self.wait(
            lambda: self.persistent_session_state(agent_id, def_id)
            in ("running", "attached"),
            what=f"persistent session {agent_id}:{def_id} to reach the running state",
            timeout=timeout,
        )

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

    # ── deferred-update banner ──────────────────────────────────────────────────
    def announce_agent_update(
        self,
        agent_id: str,
        *,
        available_version: str,
        current_version: str = "0.1.0",
        staged: bool = True,
    ) -> None:
        """Raise the backend's ``agent-update-available`` event for ``agent_id``.

        This is the **only** producer of the banner's store state: a live agent
        announces a staged update from its 24h self-update timer (behind
        ``--allow-self-update``), and the notification is not replayed on attach —
        so no UI gesture can surface the banner and the event must be injected
        (see :meth:`BridgeDriver.emit_event`, #1545).

        The payload mirrors the backend's wire shape exactly — ``agent_id`` is
        snake_case while the version fields are camelCase (``services/events.ts``
        ``onAgentUpdateAvailable``) — so the app's real ``listen`` subscription and
        the ``useAgentUpdateEvents`` folding hook are exercised, not bypassed.
        """
        self.driver.emit_event(
            "agent-update-available",
            {
                "agent_id": agent_id,
                "currentVersion": current_version,
                "availableVersion": available_version,
                "staged": staged,
            },
        )

    def agent_update_banner_testid(self, agent_id: str) -> str:
        return f"{self.UPDATE_BANNER}-{agent_id}"

    def agent_update_banner_present(self, agent_id: str) -> bool:
        return self.driver.exists(self.agent_update_banner_testid(agent_id))

    def agent_update_banner_text(self, agent_id: str) -> str:
        return self.driver.get_text(self.agent_update_banner_testid(agent_id))

    def wait_agent_update_banner(self, agent_id: str, *, timeout: float = 10.0) -> str:
        """Wait for the deferred-update banner to render and return its text.

        The event crosses the Tauri bus asynchronously, so the banner appears a
        tick or two after :meth:`announce_agent_update` returns.
        """
        self.wait(
            lambda: self.agent_update_banner_present(agent_id),
            what=f"the deferred-update banner for agent {agent_id}",
            timeout=timeout,
        )
        return self.agent_update_banner_text(agent_id)

    def wait_no_agent_update_banner(self, agent_id: str, *, timeout: float = 10.0) -> None:
        self.wait(
            lambda: not self.agent_update_banner_present(agent_id),
            what=f"the deferred-update banner for agent {agent_id} to go",
            timeout=timeout,
        )

    def agent_update_state(self, agent_id: str) -> Optional[dict[str, Any]]:
        """The store's folded ``agentUpdates[agent_id]`` record, if any.

        Reads the whole map and indexes here rather than asking for the
        ``agentUpdates.<id>`` path: an unresolved path is a ``BridgeError``, not a
        ``None``, and "no update announced yet" is an expected state this must be
        able to report (mirrors :meth:`persistent_session_state`).
        """
        value = self.driver.get_state("agentUpdates")
        if not isinstance(value, dict):
            return None
        entry = value.get(agent_id)
        return entry if isinstance(entry, dict) else None

    def dismiss_agent_update_banner(self, agent_id: str) -> None:
        """Click the banner's Dismiss and wait for it to disappear."""
        self.driver.click(f"{self.UPDATE_BANNER_DISMISS}-{agent_id}")
        self.wait_no_agent_update_banner(agent_id)

    def apply_agent_update_now(self, agent_id: str) -> None:
        """Click the banner's "Apply Now" button (does not wait for an outcome).

        Fires the ``requestAgentDeferredUpdate`` desktop command against the live
        agent's ``agent.request_deferred_update`` RPC. On a *busy* agent the RPC
        defers (``applied: false``) and the handler dismisses the banner; the
        caller waits on that dismissal (or on :meth:`agent_update_dismissed`).
        """
        self.driver.click(f"{self.UPDATE_BANNER_APPLY}-{agent_id}")

    def agent_update_dismissed(self, agent_id: str) -> bool:
        """Whether the banner for ``agent_id`` is flagged dismissed in the store.

        Reads ``agentUpdatesDismissed[agent_id]``. A *deferred* Apply Now sets this
        (the staged update still stands — it lands on the last disconnect — so only
        the banner is suppressed), whereas an Apply Now that *errored* leaves it
        false and the banner up. It therefore distinguishes the deferred success
        from a failure without reading the toast (which carries no ``data-testid``).
        """
        value = self.driver.get_state("agentUpdatesDismissed")
        return bool(value.get(agent_id)) if isinstance(value, dict) else False
