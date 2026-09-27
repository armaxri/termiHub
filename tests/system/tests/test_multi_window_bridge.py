"""Multi-window bridge routing against fake app windows (TIN-014, #3720).

Every native window of the app is its own page with its own in-app bridge, and
each dials the runner tagged with its window label. These prove the runner side
without a built app: windows are addressable by label, a secondary window never
hijacks the main-window ``wait_for_app`` contract (including across a restart
that respawns windows), and an untagged (legacy) client is still the main window.
"""

import time

import pytest

from termihub_harness import BridgeError
from fake_app import FakeApp


def label_echo(label):
    """A handler whose ``getText`` answers with the window's own label."""

    def handle(command):
        action = command.get("action")
        if action == "getText":
            return {"ok": True, "action": action, "value": f"{label}:{command['testId']}"}
        if action == "closeWindow":
            return {"ok": True, "action": action}
        if action == "listWindows":
            return {"ok": True, "action": action, "value": [{"label": "main"}, {"label": "win-1"}]}
        return {"ok": True, "action": action}

    return handle


def test_each_window_is_addressable_by_label(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        main = bridge.wait_for_app(timeout=5)
        with FakeApp(bridge.port, label_echo("win-1"), window="win-1"):
            second = main.window("win-1", timeout=5)

            assert main.window_label == "main"
            assert second.window_label == "win-1"
            assert main.get_text("t") == "main:t"
            assert second.get_text("t") == "win-1:t"
            assert main.windows() == ["main", "win-1"]


def test_window_main_returns_the_same_driver(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        main = bridge.wait_for_app(timeout=5)
        assert main.window("main") is main


def test_secondary_window_reaches_back_to_main(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        bridge.wait_for_app(timeout=5)
        with FakeApp(bridge.port, label_echo("win-1"), window="win-1"):
            second = bridge.window("win-1", timeout=5)
            assert second.window("main", timeout=5).get_text("a") == "main:a"


def test_untagged_legacy_client_is_the_main_window(bridge):
    with FakeApp(bridge.port, label_echo("main")):
        driver = bridge.wait_for_app(timeout=5)
        assert driver.window_label == "main"
        assert driver.windows() == ["main"]


def test_secondary_window_never_becomes_the_app(bridge):
    # A secondary window that connects *first* (e.g. respawned by a windowed
    # layout restore before main settles) must not be handed out as the app.
    with FakeApp(bridge.port, label_echo("win-1"), window="win-1"):
        bridge.window("win-1", timeout=5)
        with pytest.raises(TimeoutError):
            bridge.wait_for_app(timeout=0.5, settle=0)
        with FakeApp(bridge.port, label_echo("main"), window="main"):
            assert bridge.wait_for_app(timeout=5).get_text("x") == "main:x"


def test_settle_prefers_main_over_a_later_secondary(bridge):
    # The settle window used to take the *newest* connection; a secondary window
    # arriving right after main must not displace it.
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        with FakeApp(bridge.port, label_echo("win-1"), window="win-1"):
            driver = bridge.wait_for_app(timeout=5, settle=0.3)
            assert driver.window_label == "main"
            assert driver.get_text("x") == "main:x"


def test_wait_for_window_picks_up_a_newly_opened_window(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        main = bridge.wait_for_app(timeout=5)
        before = main.windows()
        with FakeApp(bridge.port, label_echo("win-2"), window="win-2"):
            new = main.wait_for_window(lambda label: label not in before, timeout=5)
            assert new.window_label == "win-2"


def test_window_times_out_when_it_never_connects(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        main = bridge.wait_for_app(timeout=5)
        with pytest.raises(TimeoutError):
            main.window("win-9", timeout=0.3)


def test_closed_window_drops_out_and_its_driver_notices(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        main = bridge.wait_for_app(timeout=5)
        second_app = FakeApp(bridge.port, label_echo("win-1"), window="win-1").start()
        second = main.window("win-1", timeout=5)
        assert second.is_connected

        second_app.stop()
        second.wait_until_closed(timeout=5)
        deadline = time.monotonic() + 5
        while "win-1" in main.windows() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert main.windows() == ["main"]
        with pytest.raises(BridgeError):
            second.get_text("gone")


def test_wait_until_closed_times_out_for_a_live_window(bridge):
    with FakeApp(bridge.port, label_echo("main"), window="main"):
        main = bridge.wait_for_app(timeout=5)
        with pytest.raises(TimeoutError):
            main.wait_until_closed(timeout=0.2)


def test_restart_reacquires_main_while_secondary_windows_come_and_go(bridge):
    first = FakeApp(bridge.port, label_echo("main"), window="main").start()
    first_second = FakeApp(bridge.port, label_echo("win-1"), window="win-1").start()
    bridge.wait_for_app(timeout=5)
    first_second.stop()
    first.stop()

    # The relaunched app restores its secondary window before main connects.
    with FakeApp(bridge.port, label_echo("win-1"), window="win-1"):
        with FakeApp(bridge.port, label_echo("main"), window="main"):
            main = bridge.wait_for_app(timeout=5)
            assert main.window_label == "main"
            assert main.window("win-1", timeout=5).get_text("r") == "win-1:r"


def test_malformed_window_label_is_refused(bridge):
    with FakeApp(bridge.port, label_echo("bogus"), window="bad%20label"):
        time.sleep(0.2)
        assert bridge.windows() == []


def test_close_and_list_window_verbs_round_trip(bridge):
    received = []

    def capture(command):
        received.append(command)
        return label_echo("main")(command)

    with FakeApp(bridge.port, capture, window="main"):
        main = bridge.wait_for_app(timeout=5)
        main.close_window()
        assert main.list_windows() == [{"label": "main"}, {"label": "win-1"}]
        assert [c["action"] for c in received] == ["closeWindow", "listWindows"]
