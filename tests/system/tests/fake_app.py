"""A fake app: a WebSocket client that answers bridge commands.

Lets the harness (bridge server + transport + Driver + sequential-connection
handling) be tested end-to-end without building the real desktop app. It plays
the role the in-app bridge plays in production — connect out, answer
``{id, command}`` envelopes with ``{id, response}`` — driven by a handler that
mimics the TypeScript dispatcher's behavior.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Callable

import websockets

Handler = Callable[[dict[str, Any]], dict[str, Any]]


class FakeApp:
    """A controllable stand-in for the in-app bridge over a real WebSocket."""

    def __init__(self, port: int, handler: Handler) -> None:
        self._url = f"ws://127.0.0.1:{port}"
        self._handler = handler
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._stop: asyncio.Future | None = None
        self._ready = threading.Event()

    def start(self) -> "FakeApp":
        self._thread = threading.Thread(target=self._run, name="fake-app", daemon=True)
        self._thread.start()
        if not self._ready.wait(5):
            raise RuntimeError("fake app failed to connect")
        return self

    def stop(self) -> None:
        loop, stop = self._loop, self._stop
        if loop is not None and stop is not None:
            loop.call_soon_threadsafe(lambda: stop.done() or stop.set_result(None))
        if self._thread is not None:
            self._thread.join(timeout=3)

    def __enter__(self) -> "FakeApp":
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.stop()

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        self._stop = loop.create_future()
        loop.run_until_complete(self._main())
        loop.close()

    async def _main(self) -> None:
        async with websockets.connect(self._url) as ws:
            self._ready.set()
            reader = asyncio.ensure_future(self._read(ws))
            assert self._stop is not None
            await self._stop
            reader.cancel()

    async def _read(self, ws: Any) -> None:
        async for message in ws:
            envelope = json.loads(message)
            response = self._handler(envelope["command"])
            await ws.send(json.dumps({"id": envelope["id"], "response": response}))


def dispatcher_like(
    terminal_text: str = "",
    state: dict | None = None,
    computed_styles: dict | None = None,
    values: dict | None = None,
    viewport: dict | None = None,
) -> Handler:
    """A handler that mimics the real dispatcher for the common command set.

    ``computed_styles`` is keyed by ``(testId or "")`` → ``{property: value}`` so
    ``getComputedStyle`` (with or without a ``testId``) can be answered.
    ``values`` is keyed by ``testId`` → live control value for ``getValue``.
    ``viewport`` is the ``{viewportY, baseY}`` returned by ``getTerminalViewport``.
    """
    state = state or {}
    computed_styles = computed_styles or {}
    values = values or {}
    viewport = viewport or {"viewportY": 0, "baseY": 0}
    recorded: dict[str, list] = {
        "clicks": [],
        "doubleClicks": [],
        "resizes": [],
        "input": [],
        "drags": [],
        "selects": [],
        "contextMenus": [],
        "pressedKeys": [],
        "dragTos": [],
        "scrolls": [],
    }

    def handle(command: dict[str, Any]) -> dict[str, Any]:
        action = command.get("action")
        if action == "click":
            recorded["clicks"].append(command["testId"])
            return {"ok": True, "action": "click"}
        if action == "doubleClick":
            recorded["doubleClicks"].append(command["testId"])
            return {"ok": True, "action": "doubleClick"}
        if action == "resizeWindow":
            recorded["resizes"].append(
                {"width": command["width"], "height": command["height"]}
            )
            return {"ok": True, "action": "resizeWindow"}
        if action == "select":
            recorded["selects"].append({"testId": command["testId"], "value": command["value"]})
            return {"ok": True, "action": "select"}
        if action == "contextMenu":
            recorded["contextMenus"].append(command["testId"])
            return {"ok": True, "action": "contextMenu"}
        if action == "pressKey":
            recorded["pressedKeys"].append(command["key"])
            return {"ok": True, "action": "pressKey"}
        if action == "dragTo":
            recorded["dragTos"].append(
                {"from": command["fromTestId"], "to": command["toTestId"]}
            )
            return {"ok": True, "action": "dragTo"}
        if action == "drag":
            recorded["drags"].append(
                {"testId": command["testId"], "dx": command["dx"], "dy": command.get("dy")}
            )
            return {"ok": True, "action": "drag"}
        if action == "getComputedStyle":
            styles = computed_styles.get(command.get("testId") or "", {})
            return {
                "ok": True,
                "action": "getComputedStyle",
                "value": styles.get(command["property"], ""),
            }
        if action == "terminalInput":
            recorded["input"].append(command["text"])
            return {"ok": True, "action": "terminalInput"}
        if action == "scrollTerminal":
            recorded["scrolls"].append(
                {
                    "lines": command.get("lines"),
                    "toBottom": command.get("toBottom"),
                    "tabId": command.get("tabId"),
                }
            )
            return {"ok": True, "action": "scrollTerminal"}
        if action == "getTerminalViewport":
            return {"ok": True, "action": "getTerminalViewport", "value": viewport}
        if action == "readTerminal":
            return {"ok": True, "action": "readTerminal", "value": terminal_text}
        if action == "getState":
            path = command.get("path")
            value = state if path is None else state.get(path)
            if path is not None and path not in state:
                return {"ok": False, "action": "getState", "error": f"no path {path}"}
            return {"ok": True, "action": "getState", "value": value}
        if action == "getValue":
            return {"ok": True, "action": "getValue", "value": values.get(command["testId"], "")}
        if action == "exists":
            return {"ok": True, "action": "exists", "value": True}
        return {"ok": False, "action": action or "?", "error": f"unhandled {action}"}

    handle.recorded = recorded  # type: ignore[attr-defined]
    return handle
