"""The runner-side WebSocket bridge server and a synchronous ``Driver``.

The app connects *out* to this server (it is the WebSocket client), so the same
path works on every platform — including macOS, where no WKWebView WebDriver
exists. This module runs an asyncio event loop on a background thread and exposes
a **synchronous** API, so test authors write plain imperative code
(``driver.click(...)``, ``app.restart()``) without ``async``/``await``.

Mirrors the runner half of the TypeScript transport (``wsServer.ts`` +
``wsTransport.ts``): per-connection monotonic request ids, response correlation,
and sequential-connection support so an app can be killed and restarted within a
single run (issue #817).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import threading
import time
from typing import Any, Optional, Sequence

import websockets

from . import deadlines, timing
from .protocol import (
    MAIN_WINDOW,
    Command,
    Response,
    decode_response,
    encode_request,
    window_from_request_path,
)


#: Named per-operation deadlines live in :mod:`.deadlines` (#3660); these aliases
#: keep the historical import names working.
DEFAULT_REQUEST_TIMEOUT = deadlines.COMMAND
#: Command timeout for the live-connect / SFTP suites (#2460) — see
#: :data:`.deadlines.LIVE_COMMAND`.
LIVE_CONNECT_REQUEST_TIMEOUT = deadlines.LIVE_COMMAND
DEFAULT_APP_WAIT_TIMEOUT = deadlines.APP_CONNECT
#: After the first app connection arrives, briefly prefer a newer one that shows
#: up within this window. An app's webview can connect and then reconnect during
#: startup (a layout-driven remount or a page reload), so the first connection is
#: sometimes transient and dies milliseconds later; binding the Driver to it
#: would fail every command. The observed gap is ~20 ms, so a fraction of a
#: second is ample headroom while keeping the per-acquire latency small.
DEFAULT_APP_SETTLE = 0.5
#: Cap for a single bridge frame. The default (1 MiB) is too small for a
#: ``screenshot`` data URL of a large window, so allow generously larger frames.
MAX_BRIDGE_FRAME_BYTES = 32 * 1024 * 1024


class BridgeError(Exception):
    """Raised when a bridge command returns ``ok: false`` or the link drops."""

    def __init__(self, action: str, message: str) -> None:
        super().__init__(message)
        self.action = action


def _request_path(ws: Any) -> str:
    """The path (with query) a client dialled, across ``websockets`` versions.

    The new asyncio server (``websockets`` >= 14) exposes it as
    ``ws.request.path``; the legacy server as ``ws.path``.
    """
    path = getattr(getattr(ws, "request", None), "path", None)
    if isinstance(path, str):
        return path
    legacy = getattr(ws, "path", None)
    return legacy if isinstance(legacy, str) else ""


class _Connection:
    """One app WebSocket connection. Lives entirely on the bridge event loop.

    ``window`` is the runtime label of the native window whose page opened the
    socket (``main``, ``win-1``, …) — see :func:`.protocol.window_from_request_path`.
    """

    def __init__(
        self, ws: Any, loop: asyncio.AbstractEventLoop, window: str = MAIN_WINDOW
    ) -> None:
        self._ws = ws
        self._loop = loop
        self.window = window
        self._next_id = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._closed = False

    async def reader(self) -> None:
        """Pump incoming response envelopes to their pending futures until close."""
        try:
            async for message in self._ws:
                decoded = decode_response(message)
                if decoded is None:
                    continue
                request_id, response = decoded
                future = self._pending.pop(request_id, None)
                if future is not None and not future.done():
                    future.set_result(response)
        except websockets.exceptions.ConnectionClosed:
            # Expected when the app is killed/restarted — not an error.
            pass
        finally:
            self._fail_all()

    def _fail_all(self) -> None:
        self._closed = True
        for future in self._pending.values():
            if not future.done():
                future.set_exception(BridgeError("", "bridge connection closed"))
        self._pending.clear()

    async def send(self, command: Command, timeout: float) -> Response:
        if self._closed:
            raise BridgeError(command.get("action", ""), "bridge connection closed")
        request_id = self._next_id
        self._next_id += 1
        future: asyncio.Future = self._loop.create_future()
        self._pending[request_id] = future
        try:
            await self._ws.send(encode_request(request_id, command))
        except websockets.exceptions.ConnectionClosed as exc:
            # The app closed the socket between our `_closed` check and this
            # send — e.g. it was killed/restarted mid-flight. A clean close
            # arrives as ConnectionClosedOK; surface it as the same BridgeError
            # a drop produces (the reader's `_fail_all` sets it for in-flight
            # requests) rather than leaking the raw websockets exception, which
            # otherwise races the reader and made this window flaky (#2359).
            self._pending.pop(request_id, None)
            raise BridgeError(
                command.get("action", ""), "bridge connection closed"
            ) from exc
        try:
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise BridgeError(
                command.get("action", ""),
                f"command timed out after {timeout}s",
            ) from exc


class Driver:
    """Synchronous façade over a single app connection.

    Query verbs return their value; action verbs return ``None``. Any ``ok: false``
    response (or a dropped connection) raises :class:`BridgeError`, so a test can
    assert with plain ``pytest`` and let unexpected failures surface as errors.
    """

    def __init__(
        self,
        connection: _Connection,
        loop: asyncio.AbstractEventLoop,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        bridge: Optional["Bridge"] = None,
    ) -> None:
        self._conn = connection
        self._loop = loop
        self._timeout = request_timeout
        # The owning server, so this driver can reach the app's other windows
        # (multi-window, #3720). ``None`` for a driver built by hand in a test.
        self._bridge = bridge

    # ── Windows (multi-window, TIN-014 / #3720) ──────────────────────────────
    @property
    def window_label(self) -> str:
        """The runtime label of the native window this driver drives (``main``, …)."""
        return self._conn.window

    @property
    def is_connected(self) -> bool:
        """Whether this window's bridge socket is still open."""
        return not self._conn._closed

    def windows(self) -> list[str]:
        """Labels of every app window with a live bridge connection, main first.

        This is the runner's view — the windows it can address with
        :meth:`window`. For the backend's own registry (which also sees a window
        whose page has not connected yet) use :meth:`list_windows`.
        """
        if self._bridge is None:
            return [self.window_label] if self.is_connected else []
        return self._bridge.windows()

    def window(
        self, label: str, *, timeout: float = DEFAULT_APP_WAIT_TIMEOUT
    ) -> "Driver":
        """A :class:`Driver` for the window labelled ``label``.

        Waits up to ``timeout`` for that window's page to connect (a window opened
        a moment ago may still be booting). ``driver.window("main")`` returns this
        driver itself when it already drives the live main window, so existing
        single-window code keeps working unchanged.
        """
        if label == self.window_label and self.is_connected:
            return self
        if self._bridge is None:
            raise BridgeError("", f"no bridge to reach window {label!r}")
        return self._bridge.window(label, timeout=timeout, request_timeout=self._timeout)

    def wait_for_window(
        self, predicate: Any = None, *, timeout: float = DEFAULT_APP_WAIT_TIMEOUT
    ) -> "Driver":
        """Wait for a window **other than those already connected** and drive it.

        ``predicate`` optionally filters candidate labels. The usual use is right
        after an action that opens a window (New Window, Move to New Window)::

            before = driver.windows()
            driver.press_key("N", ctrl=True, shift=True)
            second = driver.wait_for_window(lambda label: label not in before)
        """
        if self._bridge is None:
            raise BridgeError("", "no bridge to wait for a window on")
        return self._bridge.wait_for_window(
            predicate, timeout=timeout, request_timeout=self._timeout
        )

    def wait_until_closed(self, *, timeout: float = DEFAULT_APP_WAIT_TIMEOUT) -> None:
        """Block until this window's bridge socket closes (the window was destroyed).

        Raises ``TimeoutError`` if it is still open after ``timeout``.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if not self.is_connected:
                return
            time.sleep(0.1)
        raise TimeoutError(
            f"window {self.window_label!r} was still connected after {timeout}s"
        )

    def close_window(self) -> None:
        """Request that this window close, exactly as its title-bar close would.

        Emits the real ``close-requested`` event, so the app's close interceptor
        (#1903) decides: an empty or all-persistent window is destroyed, one that
        would lose a live session raises the "Close this window?" dialog. The
        bridge never force-destroys. The close is deferred app-side until this
        call has returned, so a window that closes at once does not swallow the
        reply — use :meth:`wait_until_closed` to wait for it to go.
        """
        self._call({"action": "closeWindow"})

    def list_windows(self) -> list[dict[str, Any]]:
        """The backend window registry: ``[{"label", "tabCount"?}, …]`` (#1900)."""
        return self._call({"action": "listWindows"})

    def _call(self, command: Command, *, timeout: Optional[float] = None) -> Any:
        # Drop None-valued keys so the wire form matches the in-process client:
        # JSON.stringify omits `undefined`, and the dispatcher distinguishes an
        # absent optional (e.g. getState path) from an explicit null.
        command = {key: value for key, value in command.items() if value is not None}
        # A per-call ``timeout`` overrides the Driver's default — used by the
        # failure-artifact probes, which must outlive the live path's own timeout
        # to capture evidence from a slow (not-yet-hung) webview (issue #2460).
        # ``ui_budget`` applies the contended-webview slow category on parallel
        # macOS/Windows workers only (#3660; see deadlines.py for the data).
        effective_timeout = deadlines.ui_budget(self._timeout if timeout is None else timeout)
        op = f"command:{command.get('action', '')}"
        started = time.monotonic()
        cfut = asyncio.run_coroutine_threadsafe(
            self._conn.send(command, effective_timeout), self._loop
        )
        try:
            response = cfut.result(effective_timeout + 5)
        except BridgeError as exc:
            if "timed out" in str(exc):
                timing.record(
                    op, time.monotonic() - started, effective_timeout, timed_out=True
                )
            raise
        timing.record(op, time.monotonic() - started, effective_timeout)
        if not response.get("ok"):
            raise BridgeError(
                response.get("action", command.get("action", "")),
                response.get("error") or "command failed",
            )
        return response.get("value")

    # ── Interaction ──────────────────────────────────────────────────────────
    def click(self, test_id: str) -> None:
        self._call({"action": "click", "testId": test_id})

    def double_click(self, test_id: str) -> None:
        """Double-click the element with ``test_id`` — the "activate" gesture.

        Opens a connection's session from the sidebar (``ConnectionList``'s
        ``onDoubleClick`` — the only path that raises the SSH key-passphrase
        prompt), enters a directory in the file browser, or opens a file in the
        editor. A single :meth:`click` cannot reach ``onDoubleClick`` handlers;
        this dispatches the full sequence a real double-click produces (two click
        rounds + ``dblclick``).
        """
        self._call({"action": "doubleClick", "testId": test_id})

    def resize_window(self, width: float, height: float) -> None:
        """Resize the app window to ``width`` × ``height`` logical pixels.

        Drives the real Tauri window via ``getCurrentWindow().setSize(...)`` so
        resize-triggered behavior runs as it does interactively: xterm's fit addon
        re-fits the terminal and re-sizes the PTY when its container changes size.
        """
        self._call({"action": "resizeWindow", "width": width, "height": height})

    def type(self, test_id: str, text: str) -> None:
        self._call({"action": "type", "testId": test_id, "text": text})

    def select(self, test_id: str, value: str) -> None:
        """Choose ``value`` on the native ``<select>`` with ``test_id``."""
        self._call({"action": "select", "testId": test_id, "value": value})

    def context_menu(self, test_id: str) -> None:
        """Open the right-click context menu of the element with ``test_id``."""
        self._call({"action": "contextMenu", "testId": test_id})

    def press_key(
        self,
        key: str,
        test_id: Optional[str] = None,
        *,
        ctrl: bool = False,
        meta: bool = False,
        shift: bool = False,
        alt: bool = False,
    ) -> None:
        """Press ``key`` on ``test_id`` (or the focused element), e.g. ``"Escape"``.

        Pass modifier flags for chords like ``Ctrl+S`` / ``Ctrl+End``. The
        dispatched event carries a real legacy ``keyCode``, so keybinding-driven
        editors (Monaco) respond as they do to real input.
        """
        self._call(
            {
                "action": "pressKey",
                "key": key,
                "testId": test_id,
                "ctrl": ctrl,
                "meta": meta,
                "shift": shift,
                "alt": alt,
            }
        )

    def editor_cursor(self, direction: str, *, times: int = 1) -> None:
        """Move the active file editor's caret ``times`` steps in ``direction``.

        Drives Monaco's cursor **command API** (``cursorUp``/``cursorDown``/…) via
        the store's ``editorActions`` rather than a synthetic arrow keydown, so it
        moves the caret deterministically on every webview — a headless CI webview
        cannot focus Monaco's hidden input, so an arrow keydown fires but no-ops
        (#2694). ``direction`` is ``"up" | "down" | "left" | "right"``.
        """
        self._call({"action": "editorCursor", "direction": direction, "times": times})

    def drag_to(self, from_test_id: str, to_test_id: str) -> None:
        """Drag one element onto another (pointer-based, e.g. @dnd-kit reorder)."""
        self._call({"action": "dragTo", "fromTestId": from_test_id, "toTestId": to_test_id})

    def drag(self, test_id: str, dx: float, dy: float = 0.0) -> None:
        """Drag an element by a pixel delta (e.g. a resize handle).

        Dispatches a synthetic ``mousedown`` → ``mousemove`` → ``mouseup`` offset
        by ``(dx, dy)`` from the element's center — the sequence drag handlers
        listen for. Only the delta matters, so absolute coordinates are not needed.
        """
        self._call({"action": "drag", "testId": test_id, "dx": dx, "dy": dy})

    def terminal_input(self, text: str, tab_id: Optional[str] = None) -> None:
        self._call({"action": "terminalInput", "text": text, "tabId": tab_id})

    def emit_event(self, event: str, payload: Any = None) -> None:
        """Emit a Tauri ``event`` with ``payload`` into the app (test mode only).

        The bridge's only non-DOM injector: every other verb drives the UI from
        the outside, so UI that renders *solely* from a backend-originated event
        is otherwise unreachable. The motivating case is the deferred-update
        banner (#1520), fed exclusively by the ``agent-update-available`` event
        an agent's 24h update timer raises::

            driver.emit_event(
                "agent-update-available",
                {
                    "agent_id": agent_id,
                    "currentVersion": "0.1.0",
                    "availableVersion": "0.2.0",
                    "staged": True,
                },
            )

        The app's real ``listen`` subscriptions and store-folding hooks run, so
        the test injects the *stimulus* and the event path stays covered — unlike
        writing the store directly. Payload keys must match the event's wire
        shape (the backend's ``snake_case``/``camelCase`` mix is deliberate).
        """
        # A ``None`` payload is dropped by `_call`, so the wire form omits the
        # key and the app emits a payload-less event — matching the in-process
        # client, where `JSON.stringify` omits `undefined`.
        self._call({"action": "emitEvent", "event": event, "payload": payload})

    # ── Introspection ────────────────────────────────────────────────────────
    def exists(self, test_id: str) -> bool:
        return bool(self._call({"action": "exists", "testId": test_id}))

    def get_text(self, test_id: str) -> str:
        return self._call({"action": "getText", "testId": test_id})

    def get_attribute(self, test_id: str, attribute: str) -> Optional[str]:
        return self._call(
            {"action": "getAttribute", "testId": test_id, "attribute": attribute}
        )

    def get_value(self, test_id: str) -> str:
        """Read the live ``value`` of an ``<input>``/``<textarea>``/``<select>``.

        Returns the DOM *property* a React-controlled field updates — unlike
        :meth:`get_attribute`, which only sees the stale markup attribute. Use
        this to assert the value a user/code set (e.g. the port field shows
        ``"22"`` or the auto-lock select is ``"never"``).
        """
        return self._call({"action": "getValue", "testId": test_id})

    def get_computed_style(self, property: str, test_id: Optional[str] = None) -> str:
        """Read a *computed* CSS property (including custom properties).

        Pass ``test_id`` to read an element; omit it to read the document root,
        where theme CSS variables like ``--bg-primary`` are defined. Unlike
        :meth:`get_attribute`, this resolves the effective value from stylesheets
        (e.g. ``cursor: col-resize`` or a theme color).
        """
        return self._call(
            {"action": "getComputedStyle", "testId": test_id, "property": property}
        )

    def sample_canvas(
        self, test_id: str, points: Sequence[tuple[int, int]] = ()
    ) -> dict[str, Any]:
        """Sample RGBA pixels of the ``<canvas>`` carrying ``test_id``.

        ``points`` are integer ``(x, y)`` coordinates in the canvas's *backing
        store* (its ``width`` x ``height``). Returns ``{"width", "height",
        "pixels"}``, where ``pixels[i]`` is ``[r, g, b, a]`` for ``points[i]``;
        with no points it reads only the size. This is how a test sees what a
        graphical remote-desktop session (VNC/RDP) actually painted — no DOM verb
        can, and the DOM :meth:`screenshot` does not capture canvas content.
        """
        return self._call(
            {
                "action": "sampleCanvas",
                "testId": test_id,
                "points": [{"x": int(x), "y": int(y)} for x, y in points],
            }
        )

    def read_terminal(
        self,
        tab_id: Optional[str] = None,
        join_full_width_rows: bool = False,
        *,
        timeout: Optional[float] = None,
    ) -> str:
        return self._call(
            {
                "action": "readTerminal",
                "tabId": tab_id,
                "joinFullWidthRows": join_full_width_rows,
            },
            timeout=timeout,
        )

    def scroll_terminal(
        self, lines: int = 0, *, to_bottom: bool = False, tab_id: Optional[str] = None
    ) -> None:
        """Scroll a terminal's viewport by ``lines`` (negative = up) or to the bottom.

        An xterm terminal renders to a canvas, so a synthetic wheel event cannot
        move it reliably. This routes through xterm's own scroll, firing the same
        ``onScroll`` a mouse wheel would — which is what the auto-scroll guard
        (#504) keys off. Active tab unless ``tab_id`` is given.
        """
        self._call(
            {
                "action": "scrollTerminal",
                "lines": lines,
                "toBottom": to_bottom,
                "tabId": tab_id,
            }
        )

    def terminal_viewport(self, tab_id: Optional[str] = None) -> dict[str, int]:
        """Read a terminal's ``{"viewportY", "baseY"}`` scroll position.

        ``viewportY < baseY`` means the user has scrolled up into the scrollback
        (auto-scroll suppressed); equal means pinned to the bottom. Lets a test
        assert auto-scroll behavior without scraping the GPU canvas. Active tab
        unless ``tab_id`` is given.
        """
        return self._call({"action": "getTerminalViewport", "tabId": tab_id})

    def get_state(self, path: Optional[str] = None, *, timeout: Optional[float] = None) -> Any:
        return self._call({"action": "getState", "path": path}, timeout=timeout)

    def screenshot(self, *, timeout: Optional[float] = None) -> str:
        """Capture a PNG screenshot of the rendered app as a data URL.

        Returns a ``data:image/png;base64,…`` string produced by rasterizing the
        live DOM. Use it for visual evidence on a manual carve-out (pixel
        geometry, theme rendering) or to enrich a failure bundle. The DOM path
        does **not** capture the xterm GPU canvas or native OS dialogs — read
        terminal text via :meth:`read_terminal` instead. Decode with
        :func:`screenshot_to_png_bytes`.

        Pass ``timeout`` to override the Driver's default command timeout — the
        failure-artifact path uses a generous one so a webview that is merely slow
        under VM load can still return a screenshot (issue #2460).
        """
        return self._call({"action": "screenshot"}, timeout=timeout)

    def sever_agent_transport(
        self, agent_id: str, *, timeout: Optional[float] = None
    ) -> bool:
        """Abruptly sever a connected agent's transport in-process (#2573).

        Drives the deterministic, cross-platform test-only sever the automated
        agent-reconnect grade (#2574) needs: the agent's I/O task drops its russh
        transport and takes the reconnect path — a faithful analog of a real
        transport loss, with no sshd kill, ``lsof``, process-title matching, or
        operator. Routes to the test-bridge-gated ``test_sever_agent_transport``
        Tauri command, which refuses unless the app was launched with the test
        bridge enabled, so a production launch can never reach it.

        Returns ``True`` when a live agent received the sever, ``False`` for an
        unknown or already-dead agent.
        """
        return bool(
            self._call(
                {"action": "severAgentTransport", "agentId": agent_id}, timeout=timeout
            )
        )

    # ── Projection substrate (#2149 / harness #2164) ─────────────────────────
    def projection_subscribe(self, region: str) -> dict[str, Any]:
        """Attach to a projection ``region`` and start recording its frames.

        Returns the recording state ``{subscriptionId, region, snapshot, frames,
        cache, dropRemaining}``. The ``subscriptionId`` is passed to the other
        ``projection_*`` verbs. The substrate's diff frames ride a per-region
        Tauri IPC channel, so they are invisible to the DOM/state verbs — this
        subscribes through the app's real transport + ``ProjectionClient`` cache
        and buffers every raw frame for assertion.
        """
        return self._call({"action": "projectionSubscribe", "region": region})

    def projection_dispatch(
        self,
        kind: str,
        payload: Any = None,
        *,
        intent_id: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Dispatch an intent (channel 1); returns the ``IntentAck`` receipt.

        The result of an accepted intent is never inline — it arrives as a diff
        frame on the affected region, recorded against any active subscription.
        ``intentId`` / ``clientId`` are minted app-side when omitted.
        """
        return self._call(
            {
                "action": "projectionDispatch",
                "kind": kind,
                "payload": payload,
                "intentId": intent_id,
                "clientId": client_id,
            }
        )

    def projection_state(self, subscription_id: str) -> dict[str, Any]:
        """Read a subscription's current recorded frames + cache state by id."""
        return self._call(
            {"action": "projectionState", "subscriptionId": subscription_id}
        )

    def projection_drop_next(self, subscription_id: str, count: int) -> None:
        """Schedule the next ``count`` delivered diffs to be dropped before the cache.

        The dropped diffs are still recorded, so the next diff arrives with a
        ``baseVersion`` ahead of the cache and trips the real gap -> resync
        re-baseline — the app's honest way to simulate a lost/reordered frame.
        """
        self._call(
            {
                "action": "projectionDropNext",
                "subscriptionId": subscription_id,
                "count": count,
            }
        )

    def projection_resync(self, subscription_id: str) -> dict[str, Any]:
        """Re-baseline a subscription's cache from the backend; returns new state."""
        return self._call(
            {"action": "projectionResync", "subscriptionId": subscription_id}
        )

    def projection_unsubscribe(self, subscription_id: str) -> None:
        """Detach one projection subscription (idempotent)."""
        self._call(
            {"action": "projectionUnsubscribe", "subscriptionId": subscription_id}
        )


def screenshot_to_png_bytes(data_url: str) -> bytes:
    """Decode a ``data:image/png;base64,…`` screenshot URL to raw PNG bytes.

    Accepts either a full data URL (the wire form :meth:`Driver.screenshot`
    returns) or a bare base64 payload. Raises ``ValueError`` if the base64 is
    malformed so a caller can fail loudly rather than write a corrupt file.
    """
    payload = data_url.split(",", 1)[1] if data_url.startswith("data:") else data_url
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"invalid base64 screenshot payload: {exc}") from exc


class Bridge:
    """A listening bridge server. Hand :attr:`port` to the app before launch."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._requested_port = port
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._server: Any = None
        self._conn_queue: Optional[asyncio.Queue] = None
        self._port: Optional[int] = None
        self._ready = threading.Event()
        self._error: Optional[BaseException] = None
        self._stop_future: Optional[asyncio.Future] = None
        # Multi-window (#3720): the live connection per window label (last one
        # wins), and an event swapped on every change so waiters can re-check.
        # Both are only touched on the bridge event loop.
        self._windows: dict[str, _Connection] = {}
        self._windows_changed: Optional[asyncio.Event] = None

    def start(self) -> "Bridge":
        """Start listening on a background thread; resolves once :attr:`port` is set."""
        self._thread = threading.Thread(target=self._run, name="bridge", daemon=True)
        self._thread.start()
        if not self._ready.wait(10) or self._error is not None:
            raise RuntimeError(f"bridge failed to start: {self._error}")
        return self

    @property
    def port(self) -> int:
        if self._port is None:
            raise RuntimeError("bridge is not started")
        return self._port

    def wait_for_app(
        self,
        timeout: float = DEFAULT_APP_WAIT_TIMEOUT,
        settle: float = DEFAULT_APP_SETTLE,
        *,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> Driver:
        """Block until the next app connects out, returning a :class:`Driver`.

        Each call consumes one connection in arrival order, so the first call
        returns the first app instance and a call after a restart returns the
        next one — the sequential-connection contract from issue #817.

        Returns the connection that *survives* startup rather than blindly the
        first to arrive: an app's webview can connect and then reconnect within
        milliseconds (a layout-driven remount or a page reload), and the first,
        transient connection then dies — so binding the Driver to it would make
        every command fail with "bridge connection closed". After the first
        connection arrives this prefers any newer one that shows up within
        ``settle``, and if the current candidate has already closed it keeps
        waiting (up to ``timeout``) for the replacement. Pass ``settle=0`` to opt
        out (take the first arrival immediately). See :data:`DEFAULT_APP_SETTLE`.

        ``request_timeout`` sets the returned Driver's default per-command timeout
        — the live-connect / SFTP suites raise it via
        :data:`LIVE_CONNECT_REQUEST_TIMEOUT` (issue #2460).
        """
        if self._loop is None or self._conn_queue is None:
            raise RuntimeError("bridge is not started")
        # The connect budget is an absolute, data-sized deadline (#3660): under
        # xdist several apps boot at once, and a serial Linux run was observed at
        # 28 s against the old 30 s budget — see deadlines.APP_CONNECT.
        timeout = deadlines.app_connect(timeout)
        started = time.monotonic()
        cfut = asyncio.run_coroutine_threadsafe(
            self._acquire_settled(timeout, settle), self._loop
        )
        try:
            connection = cfut.result(timeout + settle + 5)
        except asyncio.TimeoutError as exc:
            timing.record("app-connect", time.monotonic() - started, timeout, timed_out=True)
            raise TimeoutError(
                f"no app connected to the bridge within {timeout}s"
            ) from exc
        timing.record("app-connect", time.monotonic() - started, timeout)
        return Driver(connection, self._loop, request_timeout=request_timeout, bridge=self)

    # ── Windows (multi-window, TIN-014 / #3720) ──────────────────────────────
    def windows(self) -> list[str]:
        """Labels of every window with a live bridge connection, main first."""
        if self._loop is None:
            raise RuntimeError("bridge is not started")
        future = asyncio.run_coroutine_threadsafe(self._live_labels(), self._loop)
        return future.result(5)

    def window(
        self,
        label: str,
        *,
        timeout: float = DEFAULT_APP_WAIT_TIMEOUT,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
    ) -> Driver:
        """A :class:`Driver` for window ``label``, waiting up to ``timeout`` for it.

        Unlike :meth:`wait_for_app` this does not consume a connection from the
        main-window queue: it looks the window up in the live registry, so it can
        be called any number of times, for any window (``"main"`` included).
        """
        return self.wait_for_window(
            lambda candidate: candidate == label,
            timeout=timeout,
            request_timeout=request_timeout,
            what=f"window {label!r}",
        )

    def wait_for_window(
        self,
        predicate: Any = None,
        *,
        timeout: float = DEFAULT_APP_WAIT_TIMEOUT,
        request_timeout: float = DEFAULT_REQUEST_TIMEOUT,
        what: str = "a matching window",
    ) -> Driver:
        """Block until a live window whose label satisfies ``predicate`` connects.

        ``predicate`` defaults to "any window other than main". Returns a
        :class:`Driver` for the first match (in :meth:`windows` order).
        """
        if self._loop is None:
            raise RuntimeError("bridge is not started")
        accept = predicate or (lambda label: label != MAIN_WINDOW)
        timeout = deadlines.app_connect(timeout)
        future = asyncio.run_coroutine_threadsafe(
            self._await_window(accept, timeout), self._loop
        )
        try:
            connection = future.result(timeout + 5)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(f"{what} did not connect to the bridge within {timeout}s") from exc
        return Driver(connection, self._loop, request_timeout=request_timeout, bridge=self)

    async def _live_labels(self) -> list[str]:
        labels = [label for label, conn in self._windows.items() if not conn._closed]
        return sorted(labels, key=lambda label: (label != MAIN_WINDOW, label))

    async def _await_window(self, accept: Any, timeout: float) -> "_Connection":
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while True:
            for label in await self._live_labels():
                if accept(label):
                    return self._windows[label]
            assert self._windows_changed is not None
            changed = self._windows_changed
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError()
            try:
                await asyncio.wait_for(changed.wait(), remaining)
            except asyncio.TimeoutError:
                continue  # re-check once more, then time out above

    def _signal_windows_changed(self) -> None:
        """Wake every window waiter (runs on the bridge loop)."""
        if self._windows_changed is not None:
            self._windows_changed.set()
        self._windows_changed = asyncio.Event()

    async def _acquire_settled(self, timeout: float, settle: float) -> "_Connection":
        """Pop a connection, then prefer a newer/surviving one (see wait_for_app).

        Runs on the bridge event loop. Blocks up to ``timeout`` for the first
        connection, then: while the candidate is open, briefly (``settle``) take
        any newer arrival that supersedes it; while the candidate is closed, wait
        for its replacement until the overall ``timeout`` elapses.
        """
        assert self._conn_queue is not None
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        connection = await asyncio.wait_for(self._conn_queue.get(), timeout)
        while True:
            if connection._closed:
                # The candidate is a dead transient connection — wait for the
                # replacement up to the overall deadline.
                window = max(0.0, deadline - loop.time())
            else:
                # A healthy candidate — only briefly look for a newer connection.
                window = settle
            if window <= 0.0:
                return connection
            try:
                connection = await asyncio.wait_for(self._conn_queue.get(), window)
            except asyncio.TimeoutError:
                return connection

    def close(self) -> None:
        loop, stop = self._loop, self._stop_future
        if loop is None or stop is None:
            return
        loop.call_soon_threadsafe(lambda: stop.done() or stop.set_result(None))
        if self._thread is not None:
            self._thread.join(timeout=5)

    def __enter__(self) -> "Bridge":
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        self._conn_queue = asyncio.Queue()
        self._stop_future = loop.create_future()
        self._windows_changed = asyncio.Event()

        async def handler(ws: Any) -> None:
            window = window_from_request_path(_request_path(ws))
            if window is None:
                # A malformed window tag is refused, never mistaken for main.
                await ws.close(1008, "invalid bridge window label")
                return
            connection = _Connection(ws, loop, window=window)
            self._windows[window] = connection
            self._signal_windows_changed()
            # Only the main window takes part in the wait_for_app queue (the
            # sequential/restart contract, #817). A secondary window — opened by
            # a test, or respawned by a windowed-layout restore at boot — must
            # never be handed out (or preferred by the settle logic) as "the app".
            if window == MAIN_WINDOW:
                await self._conn_queue.put(connection)
            try:
                await connection.reader()
            finally:
                if self._windows.get(window) is connection:
                    del self._windows[window]
                self._signal_windows_changed()

        async def serve() -> None:
            self._server = await websockets.serve(
                handler,
                self._host,
                self._requested_port,
                max_size=MAX_BRIDGE_FRAME_BYTES,
            )
            self._port = self._server.sockets[0].getsockname()[1]
            self._ready.set()
            try:
                await self._stop_future
            finally:
                self._server.close()
                await self._server.wait_closed()

        try:
            loop.run_until_complete(serve())
        except BaseException as exc:  # noqa: BLE001 - surface to start()
            self._error = exc
            self._ready.set()
        finally:
            loop.close()
