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
from typing import Callable, ClassVar, Optional, TypeVar

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

    # ── Lifecycle ────────────────────────────────────────────────────────────
    def restart_app(self) -> None:
        """Kill and relaunch the app, then re-acquire the bridge for the suite."""
        self.app.restart()
        type(self).driver = self.bridge.wait_for_app()
