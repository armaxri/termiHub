"""Thin base class for system-test *suites*.

A suite is a test class that subclasses :class:`SystemTest`. Each suite gets a
**clean environment set up once** — fresh config dir, a fresh app instance, the
bridge acquired — shared by all the suite's test methods, which run in order
against that one app. After the suite, everything is torn down (housekeeping)
before the next suite starts:

    setup (clean config + launch app) ─► test_a ─► test_b ─► … ─► teardown
                                                                        │
    next suite: setup again ─► …  ◄──────────────────────────────────────┘

The base owns only what *every* suite needs: the per-suite app lifecycle, the
polling primitive :meth:`wait`, and the :meth:`delay4user` watch-along hook. All
UI-driving helpers live in **focused, composable mixins** (issue #831) that a
suite opts into by listing them ahead of ``SystemTest`` in its bases — see
:mod:`termihub_harness.ui`. A typical suite::

    @pytest.mark.integration
    class TestTerminal(TerminalUi, SystemTest):
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
from typing import Callable, ClassVar, Optional, TypeVar

import pytest

from .bridge import DEFAULT_REQUEST_TIMEOUT, Bridge, BridgeError, Driver
from .display import ensure_local_display
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
    """Per-suite app lifecycle + the ``wait`` polling primitive (one app per class).

    Combine with the ``*Ui`` mixins from :mod:`termihub_harness.ui` for the actual
    UI-driving helpers; this base deliberately stays small.
    """

    #: Set once per suite by the class-scoped fixture below.
    bridge: ClassVar[Bridge]
    app: ClassVar[AppInstance]
    driver: ClassVar[Driver]

    #: Whether :meth:`delay4user` actually sleeps. Set from ``--delay4user``.
    _delay_enabled: ClassVar[bool] = False

    #: Per-suite default for the bridge command timeout (seconds). The
    #: live-SSH-connect / SFTP suites raise this to
    #: :data:`~termihub_harness.bridge.LIVE_CONNECT_REQUEST_TIMEOUT` because a real
    #: session negotiates while the always-on Docker/``krunkit`` VMs starve the
    #: WKWebView JS thread for >10s, and the default fires mid-negotiation
    #: (issue #2460). Left at the harness default for every other suite so it does
    #: not slow the common path.
    request_timeout: ClassVar[float] = DEFAULT_REQUEST_TIMEOUT

    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def _system_test_app(cls, request: pytest.FixtureRequest):
        """Clean env + a fresh app for the whole suite; torn down afterward.

        Class-scoped and autouse, so every subclass gets exactly one app shared
        across its test methods. A ``@classmethod`` (not an instance method) so
        the attributes it sets are visible to every test in the suite; assigned
        to ``request.cls`` so each subclass gets its own, not the base. Skips the
        suite if the app is not built.

        In guided-manual runs the app's live log echo is suppressed by default so
        it does not interleave with the operator prompts (``--app-log-echo``
        forces it back on); the log is always captured to ``app.log`` (#957).
        """
        manual = bool(request.config.getoption("manual"))
        force_echo = bool(request.config.getoption("app_log_echo"))
        echo_logs = force_echo or not manual
        try:
            # fresh isolated config dir per suite
            app = AppInstance(echo_logs=echo_logs)
        except FileNotFoundError as exc:
            pytest.skip(str(exc))
        if manual and not echo_logs:
            print(f"\n[manual] app logs captured (not echoed) at: {app.log_path}")

        # Ensure the app inherits a local X11 display so the X11-forwarding test
        # can negotiate forwarding. XQuartz is only started under --manual (an
        # operator is present); otherwise this just propagates an existing
        # display and is a harmless no-op where none applies (#957).
        display = ensure_local_display(start_if_missing=manual)
        if manual and display:
            print(f"[manual] local X11 display: DISPLAY={display}")

        bridge = Bridge().start()
        try:
            app.start(bridge.port)
            driver = bridge.wait_for_app(request_timeout=request.cls.request_timeout)
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
    @property
    def config_dir(self):
        """The suite app's isolated config dir (``TERMIHUB_CONFIG_DIR``)."""
        return self.app.config_dir

    def restart_app(self, between: Optional[Callable[[], None]] = None) -> None:
        """Kill and relaunch the app, then re-acquire the bridge for the suite.

        ``between`` runs while the app is down — e.g. to corrupt a config file so
        the relaunch exercises startup recovery (see
        :class:`~termihub_harness.ui.ConfigRecoveryUi`).
        """
        self.app.restart(between)
        type(self).driver = self.bridge.wait_for_app(
            request_timeout=type(self).request_timeout
        )
