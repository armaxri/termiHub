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
from typing import Any, Callable, ClassVar, Optional, TypeVar

import pytest

from .bridge import Bridge, BridgeError, Driver
from .orchestrator import AppInstance

T = TypeVar("T")

DEFAULT_WAIT_TIMEOUT = 20.0
DEFAULT_WAIT_INTERVAL = 0.25

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
        """Type a command into the active terminal (a newline is appended)."""
        self.driver.terminal_input(command)

    def wait_for_output(self, needle: str, *, timeout: float = DEFAULT_WAIT_TIMEOUT) -> str:
        """Poll the terminal until it contains ``needle``; return the full text."""
        return self.wait(
            lambda: (lambda t: t if needle in t else None)(self.driver.read_terminal()),
            timeout=timeout,
            what=f"{needle!r} in terminal output",
        )

    # ── Panels & tabs ────────────────────────────────────────────────────────
    def panel_tree(self) -> Any:
        """The current panel tree (``rootPanel``): a leaf or a split container."""
        return self.driver.get_state("rootPanel")

    def leaf_count(self, node: Any = None) -> int:
        """Count the leaf panels in the tree (1 = unsplit, >1 = split)."""
        if node is None:
            node = self.panel_tree()
        if not isinstance(node, dict):
            return 0
        if node.get("type") == "leaf":
            return 1
        return sum(self.leaf_count(child) for child in node.get("children", []))

    def tab_ids(self, node: Any = None) -> list[str]:
        """All tab ids across every panel, in tree order."""
        if node is None:
            node = self.panel_tree()
        if not isinstance(node, dict):
            return []
        if node.get("type") == "leaf":
            return [tab["id"] for tab in node.get("tabs", []) if "id" in tab]
        ids: list[str] = []
        for child in node.get("children", []):
            ids.extend(self.tab_ids(child))
        return ids

    def close_all_tabs(self) -> None:
        """Close every open tab, collapsing splits back to a single empty panel.

        The bridge clicks programmatically, so close buttons that are only
        pointer-visible on hover are still hit (mirrors the old E2E helper).
        """
        for _ in range(50):
            ids = self.tab_ids()
            if not ids:
                break
            before = len(ids)
            self.driver.click(f"tab-close-{ids[0]}")

            def closed(before=before):
                if len(self.tab_ids()) < before:
                    return True
                # A dirty editor/connection/settings tab opens the unsaved-changes
                # dialog instead of closing — discard and continue.
                if self.driver.exists("unsaved-changes-just-close"):
                    self.driver.click("unsaved-changes-just-close")
                return False

            self.wait(closed, what="a tab to close")

    # ── Sidebar ──────────────────────────────────────────────────────────────
    def set_sidebar_visible(self, visible: bool) -> None:
        """Bring the sidebar to the wanted visibility via the toolbar toggle.

        The ``Sidebar`` renders ``null`` while collapsed, so ``exists("sidebar")``
        is the visibility signal. The toggle lives in the terminal-view toolbar,
        so a terminal is ensured first.
        """
        self.ensure_terminal()
        if self.driver.exists("sidebar") != visible:
            self.driver.click("terminal-view-toggle-sidebar")
            self.wait(
                lambda: self.driver.exists("sidebar") == visible,
                what=f"sidebar visible={visible}",
            )

    def find_tab(self, title: str) -> Optional[dict]:
        """The first tab whose ``title`` contains ``title``, or ``None``.

        Walks every panel's ``tabs`` (a tab carries its own ``title`` in state),
        the data-equivalent of the old ``findTabByTitle`` DOM scan.
        """

        def walk(node: Any) -> Optional[dict]:
            if not isinstance(node, dict):
                return None
            if node.get("type") == "leaf":
                for tab in node.get("tabs", []):
                    if title in (tab.get("title") or ""):
                        return tab
                return None
            for child in node.get("children", []):
                found = walk(child)
                if found:
                    return found
            return None

        return walk(self.panel_tree())

    # ── Settings & connections ─────────────────────────────────────────────────
    def open_settings_tab(self) -> None:
        """Open (or focus) the Settings tab via the activity-bar gear menu.

        The gear is a Radix dropdown that opens on pointer-down; ``click`` drives
        that, then we wait for the portaled menu item before selecting it.
        """
        self.driver.click("activity-bar-settings")
        self.wait(lambda: self.driver.exists("settings-menu-open"), what="the gear menu")
        self.driver.click("settings-menu-open")
        self.wait(lambda: self.find_tab("Settings") is not None, what="the Settings tab")

    def connection_id(self, name: str) -> Optional[str]:
        """The id of the saved connection named ``name`` (exact match), or ``None``."""
        for conn in self.driver.get_state("connections") or []:
            if conn.get("name") == name:
                return conn.get("id")
        return None

    def create_local_connection(self, name: str) -> str:
        """Create a local-shell connection via the editor and return its id.

        Mirrors the old ``createLocalConnection`` helper: open the new-connection
        editor (type defaults to local), set the name, save, and wait for the
        connection to land in the store.
        """
        self.driver.click("connection-list-new-connection")
        self.wait(lambda: self.driver.exists("connection-editor-name-input"), what="the editor")
        self.driver.type("connection-editor-name-input", name)
        self.driver.click("connection-editor-save")
        self.wait(lambda: self.connection_id(name) is not None, what=f"connection {name!r}")
        return self.connection_id(name)

    def connect_to(self, name: str) -> None:
        """Open a saved connection through its right-click → Connect action."""
        conn_id = self.connection_id(name)
        assert conn_id is not None, f"no saved connection named {name!r}"
        self.driver.right_click(f"connection-item-{conn_id}")
        self.driver.click("context-connection-connect")
        self.wait(lambda: self.find_tab(name) is not None, what=f"a tab for {name!r}")

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
