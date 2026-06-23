"""End-to-end harness tests against a fake app — no built desktop app needed.

These prove the whole runner-side machinery (bridge server, response
correlation, the synchronous Driver, and sequential-connection / restart
support) without depending on a real build, so they run anywhere and fast.
"""

import pytest

from termihub_harness import BridgeError
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

        assert handler.recorded["selects"] == [{"testId": "theme-select", "value": "light"}]
        assert handler.recorded["contextMenus"] == ["tab-1"]
        assert handler.recorded["pressedKeys"] == ["Escape"]
        assert handler.recorded["dragTos"] == [{"from": "tab-1", "to": "tab-2"}]


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
