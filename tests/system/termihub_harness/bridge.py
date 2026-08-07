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
from typing import Any, Optional

import websockets

from .protocol import Command, Response, decode_response, encode_request

DEFAULT_REQUEST_TIMEOUT = 10.0
#: Command timeout for the **live-connect / SFTP** suites (issue #2460). A real
#: SSH session negotiates while the always-on Docker (``--cpus 10``) + podman
#: ``krunkit`` VMs intermittently starve the macOS WKWebView JS thread for >10s,
#: so the default 10s fires mid-negotiation and the whole live suite times out
#: even though the backend is fine. 60s is deliberately generous: it is long
#: enough to let a webview that is merely *slow under load* finish (the suite then
#: passes), while a run that still times out at 60s is strong evidence the webview
#: is *genuinely hung* rather than slow — the #2460 hypothesis test. Scoped to the
#: live suites (via ``SystemTest.request_timeout``); it does **not** slow every
#: verb globally.
LIVE_CONNECT_REQUEST_TIMEOUT = 60.0
DEFAULT_APP_WAIT_TIMEOUT = 30.0
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


class _Connection:
    """One app WebSocket connection. Lives entirely on the bridge event loop."""

    def __init__(self, ws: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._ws = ws
        self._loop = loop
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
    ) -> None:
        self._conn = connection
        self._loop = loop
        self._timeout = request_timeout

    def _call(self, command: Command, *, timeout: Optional[float] = None) -> Any:
        # Drop None-valued keys so the wire form matches the in-process client:
        # JSON.stringify omits `undefined`, and the dispatcher distinguishes an
        # absent optional (e.g. getState path) from an explicit null.
        command = {key: value for key, value in command.items() if value is not None}
        # A per-call ``timeout`` overrides the Driver's default — used by the
        # failure-artifact probes, which must outlive the live path's own timeout
        # to capture evidence from a slow (not-yet-hung) webview (issue #2460).
        effective_timeout = self._timeout if timeout is None else timeout
        cfut = asyncio.run_coroutine_threadsafe(
            self._conn.send(command, effective_timeout), self._loop
        )
        response = cfut.result(effective_timeout + 5)
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
        cfut = asyncio.run_coroutine_threadsafe(
            self._acquire_settled(timeout, settle), self._loop
        )
        try:
            connection = cfut.result(timeout + settle + 5)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"no app connected to the bridge within {timeout}s"
            ) from exc
        return Driver(connection, self._loop, request_timeout=request_timeout)

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

        async def handler(ws: Any) -> None:
            connection = _Connection(ws, loop)
            await self._conn_queue.put(connection)
            await connection.reader()

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
