"""End-to-end harness tests against a fake app — no built desktop app needed.

These prove the whole runner-side machinery (bridge server, response
correlation, the synchronous Driver, and sequential-connection / restart
support) without depending on a real build, so they run anywhere and fast.
"""

import time

import pytest

from termihub_harness import LIVE_CONNECT_REQUEST_TIMEOUT, BridgeError
from fake_app import FakeApp, dispatcher_like


def test_driver_drives_a_fake_app(bridge):
    handler = dispatcher_like(terminal_text="user@host:~$ echo hi\nhi\n", state={"activePanelId": "p1"})
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        driver.click("connection-item-abc")
        driver.terminal_input("echo hi")

        assert "hi" in driver.read_terminal()
        assert driver.exists("anything") is True
        assert driver.get_state("activePanelId") == "p1"
        assert handler.recorded["clicks"] == ["connection-item-abc"]
        assert handler.recorded["input"] == ["echo hi"]


def test_drag_and_computed_style_round_trip(bridge):
    handler = dispatcher_like(
        computed_styles={
            "sidebar-resize-handle": {"cursor": "col-resize"},
            "": {"--bg-primary": "#1e1e1e"},
        }
    )
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        driver.drag("sidebar-resize-handle", 100, 5)
        assert handler.recorded["drags"] == [
            {"testId": "sidebar-resize-handle", "dx": 100, "dy": 5}
        ]

        assert driver.get_computed_style("cursor", "sidebar-resize-handle") == "col-resize"
        # Omitting the test id reads the document root (theme CSS variables).
        assert driver.get_computed_style("--bg-primary") == "#1e1e1e"


def test_extended_interaction_verbs_round_trip(bridge):
    handler = dispatcher_like()
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        driver.select("theme-select", "light")
        driver.context_menu("tab-1")
        driver.press_key("Escape")
        driver.drag_to("tab-1", "tab-2")
        driver.double_click("file-row-notes.txt")

        assert handler.recorded["selects"] == [{"testId": "theme-select", "value": "light"}]
        assert handler.recorded["contextMenus"] == ["tab-1"]
        assert handler.recorded["pressedKeys"] == ["Escape"]
        assert handler.recorded["dragTos"] == [{"from": "tab-1", "to": "tab-2"}]
        assert handler.recorded["doubleClicks"] == ["file-row-notes.txt"]


def test_press_key_modifiers_round_trip(bridge):
    # A custom handler that echoes the whole pressKey command, so the modifier
    # flags can be asserted (dispatcher_like only records the bare key).
    received = []

    def capture(command):
        if command["action"] == "pressKey":
            received.append(command)
        return {"ok": True, "action": command["action"]}

    with FakeApp(bridge.port, capture):
        driver = bridge.wait_for_app(timeout=5)
        driver.press_key("s", "editor-input", ctrl=True)
        driver.press_key("End", ctrl=True, shift=True)

    assert received[0]["key"] == "s"
    assert received[0]["testId"] == "editor-input"
    assert received[0]["ctrl"] is True
    assert received[0]["meta"] is False
    assert received[1]["key"] == "End"
    assert received[1]["ctrl"] is True and received[1]["shift"] is True


def test_terminal_scroll_round_trip(bridge):
    handler = dispatcher_like(viewport={"viewportY": 5, "baseY": 42})
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        driver.scroll_terminal(-2000)
        driver.scroll_terminal(to_bottom=True, tab_id="tab-9")

        assert handler.recorded["scrolls"] == [
            {"lines": -2000, "toBottom": False, "tabId": None},
            {"lines": 0, "toBottom": True, "tabId": "tab-9"},
        ]
        # `viewportY < baseY` here means the user is scrolled up into scrollback.
        assert driver.terminal_viewport() == {"viewportY": 5, "baseY": 42}


def test_pointer_and_window_verbs_round_trip(bridge):
    handler = dispatcher_like()
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        driver.double_click("connection-item-abc")
        driver.resize_window(640, 480)

        assert handler.recorded["doubleClicks"] == ["connection-item-abc"]
        assert handler.recorded["resizes"] == [{"width": 640, "height": 480}]


def test_get_value_round_trip(bridge):
    handler = dispatcher_like(values={"field-port": "22"})
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)
        assert driver.get_value("field-port") == "22"


def test_emit_event_round_trips_name_and_payload(bridge):
    handler = dispatcher_like()
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        payload = {
            "agent_id": "agent-1",
            "currentVersion": "0.1.0",
            "availableVersion": "0.2.0",
            "staged": True,
        }
        driver.emit_event("agent-update-available", payload)

        assert handler.recorded["events"] == [
            {"event": "agent-update-available", "payload": payload}
        ]


def test_emit_event_without_payload_omits_the_key(bridge):
    handler = dispatcher_like()
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)

        driver.emit_event("credential-store-locked")

        # A `None` payload is dropped on the wire, so the app emits a
        # payload-less event — matching `JSON.stringify` omitting `undefined`.
        assert handler.recorded["events"] == [
            {"event": "credential-store-locked", "payload": None}
        ]


def test_emit_event_empty_name_raises_bridge_error(bridge):
    with FakeApp(bridge.port, dispatcher_like()):
        driver = bridge.wait_for_app(timeout=5)
        with pytest.raises(BridgeError):
            driver.emit_event("")


def test_screenshot_round_trip(bridge):
    data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="
    handler = dispatcher_like(screenshot=data_url)
    with FakeApp(bridge.port, handler):
        driver = bridge.wait_for_app(timeout=5)
        assert driver.screenshot() == data_url


def test_screenshot_unavailable_raises_bridge_error(bridge):
    # No screenshot configured → the fake app reports capture unavailable.
    with FakeApp(bridge.port, dispatcher_like()):
        driver = bridge.wait_for_app(timeout=5)
        with pytest.raises(BridgeError):
            driver.screenshot()


def test_ok_false_raises_bridge_error(bridge):
    with FakeApp(bridge.port, dispatcher_like(state={})):
        driver = bridge.wait_for_app(timeout=5)
        with pytest.raises(BridgeError) as excinfo:
            driver.get_state("missing.path")
        assert "missing.path" in str(excinfo.value)


def test_concurrent_commands_correlate_by_id(bridge):
    # A handler that returns the command's own testId so we can detect mismatches.
    def echoing(command):
        if command["action"] == "getText":
            return {"ok": True, "action": "getText", "value": command["testId"]}
        return {"ok": True, "action": command["action"]}

    with FakeApp(bridge.port, echoing):
        driver = bridge.wait_for_app(timeout=5)
        assert driver.get_text("alpha") == "alpha"
        assert driver.get_text("beta") == "beta"


def test_sequential_connections_survive_restart(bridge):
    """Kill the (fake) app, start a new one, and drive it over the same server."""
    first = FakeApp(bridge.port, dispatcher_like(terminal_text="first\n")).start()
    driver_a = bridge.wait_for_app(timeout=5)
    assert "first" in driver_a.read_terminal()
    first.stop()

    # The old transport must now fail fast rather than hang.
    with pytest.raises(BridgeError):
        driver_a.read_terminal()

    with FakeApp(bridge.port, dispatcher_like(terminal_text="second\n")):
        driver_b = bridge.wait_for_app(timeout=5)
        assert "second" in driver_b.read_terminal()


# ── Startup-reconnect resilience (#1019): bind to the surviving connection ──────
def test_wait_for_app_prefers_a_newer_connection(bridge):
    # Two connections arrive close together (a startup reload connects, then
    # reconnects). wait_for_app must return the *newer* one, since the first is
    # the transient that will be discarded — not whichever arrived first.
    transient = FakeApp(bridge.port, dispatcher_like(terminal_text="transient\n"))
    stable = FakeApp(bridge.port, dispatcher_like(terminal_text="stable\n"))
    with transient, stable:  # `transient` connects first, then `stable`
        driver = bridge.wait_for_app(timeout=5)
        assert "stable" in driver.read_terminal()


def test_wait_for_app_skips_a_dead_transient_connection(bridge):
    # The first connection has already dropped by the time we acquire (the
    # classic startup-reload race). wait_for_app must wait past the dead one and
    # return the live replacement rather than handing back a closed socket.
    transient = FakeApp(bridge.port, dispatcher_like(terminal_text="transient\n")).start()
    transient.stop()  # it connected, then immediately went away
    with FakeApp(bridge.port, dispatcher_like(terminal_text="stable\n")):
        driver = bridge.wait_for_app(timeout=5)
        assert "stable" in driver.read_terminal()


def test_wait_for_app_returns_a_lone_stable_connection(bridge):
    # The common case: exactly one connection, which stays up. The settle window
    # must not discard it — it is returned (after the brief settle).
    with FakeApp(bridge.port, dispatcher_like(terminal_text="only\n")):
        driver = bridge.wait_for_app(timeout=5)
        assert "only" in driver.read_terminal()


def test_wait_for_app_settle_zero_takes_the_first_arrival(bridge):
    # settle=0 opts out of the preference window: the first connection is taken
    # immediately even when a second is already waiting behind it.
    first = FakeApp(bridge.port, dispatcher_like(terminal_text="first\n"))
    second = FakeApp(bridge.port, dispatcher_like(terminal_text="second\n"))
    with first, second:
        driver = bridge.wait_for_app(timeout=5, settle=0)
        assert "first" in driver.read_terminal()


def test_request_timeout_sets_the_driver_default(bridge):
    # The live-connect suites raise the per-command timeout via this path (#2460).
    with FakeApp(bridge.port, dispatcher_like()):
        driver = bridge.wait_for_app(timeout=5, request_timeout=LIVE_CONNECT_REQUEST_TIMEOUT)
        assert driver._timeout == LIVE_CONNECT_REQUEST_TIMEOUT


def test_per_call_timeout_override_is_honored(bridge):
    # A slow handler lets a tight per-call timeout fire while the driver default
    # comfortably outlasts it — the mechanism the failure-artifact probes use to
    # capture evidence with a longer timeout than the live path (#2460).
    def slow_handler(command):
        time.sleep(0.4)
        return {"ok": True, "action": command.get("action"), "value": {}}

    with FakeApp(bridge.port, slow_handler):
        driver = bridge.wait_for_app(timeout=5)
        with pytest.raises(BridgeError):
            driver.get_state(timeout=0.05)
        # The generous default (10s) rides out the same slow handler.
        assert driver.get_state() == {}
