"""Base class for system-test *suites*.

A suite is a test class that subclasses :class:`SystemTest`. Each suite gets a
**clean environment set up once** — fresh config dir, a fresh app instance, the
bridge acquired — shared by all the suite's test methods, which run in order
against that one app. After the suite, everything is torn down (housekeeping)
before the next suite starts:

    setup (clean config + launch app) ─► test_a ─► test_b ─► … ─► teardown
                                                                        │
    next suite: setup again ─► …  ◄──────────────────────────────────────┘

The base also provides the polling/terminal helpers that nearly every suite
needs, so individual tests stay short and declarative:

    @pytest.mark.integration
    class TestTerminal(SystemTest):
        def test_echo(self):
            self.ensure_terminal()
            self.run_command("echo hi")
            assert "hi" in self.wait_for_output("hi")

Suites that do not need a real app (pure harness/protocol checks) should drive a
``FakeApp`` instead and not subclass this — see ``tests/test_roundtrip.py``.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Callable, ClassVar, Optional, TypeVar

import pytest

from .bridge import Bridge, BridgeError, Driver
from .fixtures import SSH_PASSWORD
from .orchestrator import AppInstance

T = TypeVar("T")

DEFAULT_WAIT_TIMEOUT = 20.0
DEFAULT_WAIT_INTERVAL = 0.25


def unique_name(purpose: str) -> str:
    """A collision-free connection name, like the old E2E ``uniqueName`` helper.

    Tabs persist across a suite's methods, so each connection needs a distinct
    name to avoid aliasing an earlier method's tab.
    """
    return f"sys-{purpose}-{uuid.uuid4().hex[:8]}"


class SystemTest:
    """Shared setup + helpers for an integration suite (one app per class)."""

    #: Set once per suite by the class-scoped fixture below.
    bridge: ClassVar[Bridge]
    app: ClassVar[AppInstance]
    driver: ClassVar[Driver]

    #: Whether :meth:`delay4user` actually sleeps. Set from ``--delay4user``.
    _delay_enabled: ClassVar[bool] = False

    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def _system_test_app(cls, request: pytest.FixtureRequest):
        """Clean env + a fresh app for the whole suite; torn down afterward.

        Class-scoped and autouse, so every subclass gets exactly one app shared
        across its test methods. A ``@classmethod`` (not an instance method) so
        the attributes it sets are visible to every test in the suite; assigned
        to ``request.cls`` so each subclass gets its own, not the base. Skips the
        suite if the app is not built.
        """
        try:
            app = AppInstance()  # fresh isolated config dir per suite
        except FileNotFoundError as exc:
            pytest.skip(str(exc))

        bridge = Bridge().start()
        try:
            app.start(bridge.port)
            driver = bridge.wait_for_app()
        except BaseException:
            bridge.close()
            app.cleanup()
            raise

        request.cls.bridge = bridge
        request.cls.app = app
        request.cls.driver = driver
        request.cls._delay_enabled = bool(request.config.getoption("delay4user"))
        try:
            yield
        finally:
            bridge.close()
            app.cleanup()

    # ── Polling ──────────────────────────────────────────────────────────────
    def wait(
        self,
        predicate: Callable[[], T],
        *,
        timeout: float = DEFAULT_WAIT_TIMEOUT,
        interval: float = DEFAULT_WAIT_INTERVAL,
        what: str = "condition",
    ) -> T:
        """Poll ``predicate`` until it returns truthy, retrying on ``BridgeError``.

        The UI is asynchronous (a shell prints when ready, output streams in), so
        a read right after an action usually needs polling. A ``BridgeError``
        (e.g. "no active terminal" before one exists) counts as "not ready yet".
        """
        deadline = time.monotonic() + timeout
        last_error: Optional[BridgeError] = None
        while time.monotonic() < deadline:
            try:
                result = predicate()
                if result:
                    return result
            except BridgeError as exc:
                last_error = exc
            time.sleep(interval)
        raise AssertionError(f"timed out waiting for {what} (last error: {last_error})")

    # ── Terminal ─────────────────────────────────────────────────────────────
    def has_terminal(self) -> bool:
        """Whether a readable terminal currently exists."""
        try:
            self.driver.read_terminal()
            return True
        except BridgeError:
            return False

    def ensure_terminal(self) -> None:
        """Make sure a terminal exists and its shell has printed a prompt."""
        if not self.has_terminal():
            self.driver.click("terminal-view-new-terminal")
        self.wait(self.has_terminal, what="a terminal to exist")
        self.wait(lambda: self.driver.read_terminal().strip() != "", what="the shell prompt")

    def run_command(self, command: str) -> None:
        """Type a command into the active terminal (a newline is appended).

        Retries while the backend session is still registering: an SSH session
        connects asynchronously, so the terminal buffer can be readable a moment
        before its session accepts input. A failed send transmits nothing, so the
        retry never double-sends.
        """
        self.wait(
            lambda: self._send_terminal_input(command),
            what="the terminal session to accept input",
        )

    def _send_terminal_input(self, command: str) -> bool:
        """``driver.terminal_input`` that returns True, for :meth:`wait`."""
        self.driver.terminal_input(command)
        return True

    def wait_for_output(self, needle: str, *, timeout: float = DEFAULT_WAIT_TIMEOUT) -> str:
        """Poll the terminal until it contains ``needle``; return the full text."""
        return self.wait(
            lambda: (lambda t: t if needle in t else None)(self.driver.read_terminal()),
            timeout=timeout,
            what=f"{needle!r} in terminal output",
        )

    # ── Connection editor ──────────────────────────────────────────────────────
    def _try_select(self, test_id: str, value: str) -> bool:
        """``driver.select`` that returns True, for use as a :meth:`wait` predicate.

        A native ``<select>`` whose options load asynchronously raises a
        ``BridgeError`` ("option … not found") until the option exists; wrapping
        the call lets :meth:`wait` retry until it succeeds.
        """
        self.driver.select(test_id, value)
        return True

    def open_new_connection_editor(self) -> None:
        """Open a fresh connection editor and wait for its name field."""
        self.driver.click("connection-list-new-connection")
        self.wait(
            lambda: self.driver.exists("connection-editor-name-input"),
            what="the connection editor",
        )

    def create_ssh_connection(
        self,
        name: str,
        *,
        host: str,
        port: int,
        username: str,
        auth_method: str = "password",
        key_path: Optional[str] = None,
        connect: bool = False,
    ) -> None:
        """Fill the editor for an SSH connection and save (or Save & Connect).

        ``connect=True`` clicks **Save & Connect**, which saves then immediately
        opens the session — raising the password prompt for password auth — so a
        test never needs a sidebar double-click. ``auth_method`` selects the
        native ``field-authMethod`` dropdown; pass ``key_path`` for key auth.
        """
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        # The type <select>'s options come from the async-loaded `connectionTypes`
        # store, so they can lag the editor render — retry the select until the
        # "ssh" option exists (self.wait swallows the BridgeError and retries).
        self.wait(
            lambda: self._try_select("connection-editor-type-select", "ssh"),
            what="the connection-type options to load",
        )
        self.wait(
            lambda: self.driver.exists("field-host"), what="the SSH connection fields"
        )
        self.driver.type("field-host", str(host))
        self.driver.type("field-port", str(port))
        self.driver.type("field-username", username)
        if auth_method:
            self.driver.select("field-authMethod", auth_method)
        if key_path is not None:
            # The keyPath field renders a KeyPathInput (with browse + key
            # autocomplete), so its input testid is the KeyPathInput one, not a
            # plain ``field-keyPath``.
            key_input = "field-keyPath-key-path-input"
            self.wait(
                lambda: self.driver.exists(key_input), what="the SSH key-path field"
            )
            self.driver.type(key_input, str(key_path))
        self.driver.click(
            "connection-editor-save-connect" if connect else "connection-editor-save"
        )

    # ── Password prompt ────────────────────────────────────────────────────────
    def password_prompt_open(self) -> bool:
        """Whether the SSH password prompt modal is currently open."""
        return bool(self.driver.get_state("passwordPromptOpen"))

    def handle_password_prompt(self, password: str = SSH_PASSWORD) -> None:
        """Wait for the password prompt, enter ``password``, and click Connect."""
        self.wait(
            lambda: self.driver.exists("password-prompt-input"),
            what="the SSH password prompt",
        )
        self.driver.type("password-prompt-input", password)
        self.driver.click("password-prompt-connect")

    def cancel_password_prompt(self) -> None:
        """Dismiss the password prompt without connecting."""
        self.driver.click("password-prompt-cancel")

    # ── Tabs ───────────────────────────────────────────────────────────────────
    def _all_tabs(self) -> list[dict[str, Any]]:
        """Every open tab in the active tab group (walks the panel tree)."""
        tabs: list[dict[str, Any]] = []

        def walk(node: Any) -> None:
            if not isinstance(node, dict):
                return
            if node.get("type") == "leaf":
                tabs.extend(node.get("tabs") or [])
            else:
                for child in node.get("children") or []:
                    walk(child)

        walk(self.driver.get_state("rootPanel"))
        return tabs

    def tab_count(self) -> int:
        """Number of open tabs across the active tab group's panels."""
        return len(self._all_tabs())

    def find_tab(self, title_substr: str) -> Optional[dict[str, Any]]:
        """Return the first tab whose title contains ``title_substr``, or None."""
        for tab in self._all_tabs():
            if title_substr in (tab.get("title") or ""):
                return tab
        return None

    def active_tab(self) -> Optional[dict[str, Any]]:
        """The focused tab in the active leaf panel, or None."""
        active_panel_id = self.driver.get_state("activePanelId")

        def find_leaf(node: Any) -> Optional[dict[str, Any]]:
            if not isinstance(node, dict):
                return None
            if node.get("type") == "leaf":
                return node if node.get("id") == active_panel_id else None
            for child in node.get("children") or []:
                found = find_leaf(child)
                if found is not None:
                    return found
            return None

        leaf = find_leaf(self.driver.get_state("rootPanel"))
        if leaf is None:
            return None
        active_tab_id = leaf.get("activeTabId")
        for tab in leaf.get("tabs") or []:
            if tab.get("id") == active_tab_id:
                return tab
        return None

    def switch_to_tab(self, tab_id: str) -> None:
        """Click the tab with the given id to make it active."""
        self.driver.click(f"tab-{tab_id}")

    def close_tab(self, tab_id: str) -> None:
        """Close the tab with the given id, confirming any close dialog."""
        self.driver.click(f"tab-close-{tab_id}")
        time.sleep(0.3)
        if self.driver.exists("confirm-close-tab-confirm"):
            self.driver.click("confirm-close-tab-confirm")

    def close_all_tabs(self) -> None:
        """Close every open tab (e.g. between reconnect checks)."""
        for _ in range(20):
            tabs = self._all_tabs()
            if not tabs:
                return
            self.close_tab(tabs[0]["id"])
            time.sleep(0.2)

    # ── Monitoring ─────────────────────────────────────────────────────────────
    def monitoring_visible(self) -> bool:
        """Whether any monitoring status-bar element is present (any state)."""
        return any(
            self.driver.exists(test_id)
            for test_id in (
                "monitoring-connect-btn",
                "monitoring-loading",
                "monitoring-host",
                "monitoring-cpu",
            )
        )

    def monitoring_stats(self) -> Optional[dict[str, str]]:
        """The connected monitoring stats (cpu/mem/disk text), or None."""
        if not self.driver.exists("monitoring-cpu"):
            return None
        return {
            "cpu": self.driver.get_text("monitoring-cpu"),
            "mem": self.driver.get_text("monitoring-mem"),
            "disk": self.driver.get_text("monitoring-disk"),
        }

    def wait_for_monitoring_stats(self, *, timeout: float = 20.0) -> dict[str, str]:
        """Poll until monitoring has connected and shows stats; return them."""
        return self.wait(
            self.monitoring_stats, timeout=timeout, what="monitoring stats to appear"
        )

    def open_monitoring_dropdown(self) -> None:
        """Click the monitoring host chip to open its refresh/disconnect menu."""
        self.driver.click("monitoring-host")
        self.wait(
            lambda: self.driver.exists("monitoring-disconnect"),
            what="the monitoring dropdown",
        )

    def monitoring_refresh(self) -> None:
        """Open the monitoring dropdown and click Refresh."""
        self.open_monitoring_dropdown()
        self.driver.click("monitoring-refresh")

    def monitoring_disconnect(self) -> None:
        """Open the monitoring dropdown and click Disconnect."""
        self.open_monitoring_dropdown()
        self.driver.click("monitoring-disconnect")

    # ── Sidebars / file browser ────────────────────────────────────────────────
    def _ensure_sidebar(self, view: str, test_id: str) -> None:
        """Show the given sidebar ``view`` (idempotent).

        Clicking an already-active activity-bar icon *toggles the sidebar
        closed*, so only click when ``view`` isn't already the visible one.
        """
        try:
            showing = self.driver.get_state("sidebarView") == view and not self.driver.get_state(
                "sidebarCollapsed"
            )
        except BridgeError:
            showing = False
        if not showing:
            self.driver.click(test_id)

    def switch_to_files_sidebar(self) -> None:
        """Open the SFTP file-browser sidebar from the activity bar."""
        self._ensure_sidebar("files", "activity-bar-file-browser")

    def switch_to_connections_sidebar(self) -> None:
        """Return to the connections sidebar from the activity bar."""
        self._ensure_sidebar("connections", "activity-bar-connections")

    def connect_sftp_browser(self, password: str = SSH_PASSWORD) -> str:
        """Open the file browser for the active SSH tab and wait for its path.

        Switches to the Files sidebar; SFTP auto-connects (prompting for a
        password when none is cached) and the browser follows the terminal's CWD.
        Returns the displayed path.
        """
        self.switch_to_files_sidebar()
        if self.wait(
            lambda: self.driver.exists("password-prompt-input")
            or self.driver.exists("file-browser-current-path"),
            what="the SFTP browser or its password prompt",
        ):
            if self.driver.exists("password-prompt-input"):
                self.handle_password_prompt(password)
        return self.wait(
            lambda: self.driver.get_text("file-browser-current-path"),
            what="the file-browser path",
        )

    def file_browser_path(self) -> str:
        """The path currently shown in the file browser (empty if none)."""
        if not self.driver.exists("file-browser-current-path"):
            return ""
        return self.driver.get_text("file-browser-current-path")

    # ── Settings ───────────────────────────────────────────────────────────────
    def open_settings_tab(self) -> None:
        """Open the Settings editor tab from the activity-bar gear menu."""
        self.driver.click("activity-bar-settings")
        self.wait(
            lambda: self.driver.exists("settings-menu-open"), what="the settings menu"
        )
        self.driver.click("settings-menu-open")

    def enable_experimental_features(self) -> None:
        """Turn on experimental features (reveals the Tunnels/Services views)."""
        if self._experimental_enabled():
            return
        self.open_settings_category("general")
        self.wait(
            lambda: self.driver.exists("settings-experimental-features"),
            what="the experimental-features toggle",
        )
        self.driver.click("settings-experimental-features")
        self.wait(self._experimental_enabled, what="experimental features to enable")
        self.switch_to_connections_sidebar()

    def _experimental_enabled(self) -> bool:
        # The setting is absent from the store until first set, so a missing path
        # (BridgeError) means "off".
        try:
            return bool(self.driver.get_state("settings.experimentalFeaturesEnabled"))
        except BridgeError:
            return False

    def open_settings_category(self, category: str) -> None:
        """Open Settings and select a category nav item (e.g. ``external-files``).

        Only the active category's fields are mounted, so a setting like
        ``toggle-power-monitoring`` (under *external-files*) must be navigated to.
        """
        self.open_settings_tab()
        nav = f"settings-nav-{category}"
        self.wait(lambda: self.driver.exists(nav), what=f"the {category} settings nav")
        self.driver.click(nav)

    # ── Watch-along ──────────────────────────────────────────────────────────
    def delay4user(self, seconds: float = 1.0, reason: str = "") -> None:
        """Sleep so a human can see the last UI change — only under ``--delay4user``.

        A no-op in normal / CI / AI-agent runs (the flag is off), so these calls
        cost nothing there. Set ``seconds`` per call — pass a longer value for
        changes that are harder to spot. Sprinkle calls wherever following along
        matters::

            self.run_command("echo hi")
            self.delay4user(2, reason="watch the output appear")
        """
        if not self._delay_enabled:
            return
        label = f" — {reason}" if reason else ""
        print(f"\n⏸  delay4user: sleeping {seconds:.1f}s{label}", flush=True)
        time.sleep(seconds)

    # ── Lifecycle ────────────────────────────────────────────────────────────
    def restart_app(self) -> None:
        """Kill and relaunch the app, then re-acquire the bridge for the suite."""
        self.app.restart()
        type(self).driver = self.bridge.wait_for_app()
