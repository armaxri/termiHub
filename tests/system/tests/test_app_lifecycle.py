"""The review-gate lifecycle test: drive the real app, then kill and restart it.

Proves the whole concept end-to-end on the built app:
  - launch the app so it connects out to the bridge (cross-platform, incl. macOS),
  - open a terminal and write a command into it (``terminalInput``, issue #818),
  - read the real xterm buffer back and assert the output,
  - kill the app and restart it, re-acquiring the bridge (issue #817),
  - confirm the restarted instance is drivable.

Marked ``integration``: requires `pnpm tauri build`. Skipped automatically when
the app is not built (see the ``app`` fixture).
"""

import time

import pytest

from termihub_harness import BridgeError

pytestmark = pytest.mark.integration

WAIT_APP = 45.0


def _wait(predicate, timeout=20.0, interval=0.25, what="condition"):
    """Poll ``predicate`` until it returns a truthy value or time runs out."""
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = predicate()
            if result:
                return result
        except BridgeError as exc:
            last_error = exc
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {what} (last error: {last_error})")


def _has_terminal(driver) -> bool:
    try:
        driver.read_terminal()
        return True
    except BridgeError:
        return False


def test_app_lifecycle(bridge, app):
    # ── Launch and acquire the bridge ────────────────────────────────────────
    app.start(bridge.port)
    driver = bridge.wait_for_app(timeout=WAIT_APP)
    assert isinstance(driver.get_state(), dict), "app should be introspectable once connected"

    # ── Ensure a live terminal whose shell is ready for input ────────────────
    if not _has_terminal(driver):
        driver.click("terminal-view-new-terminal")
    _wait(lambda: _has_terminal(driver), what="a terminal to exist")
    # Wait for the shell to print its prompt, so the session is registered and
    # accepting input before we type into it.
    _wait(lambda: driver.read_terminal().strip() != "", what="the shell prompt")

    # ── Write into the terminal once, then poll the output (no re-sends) ──────
    marker = "HELLO_FROM_BRIDGE_4242"
    driver.terminal_input(f"echo {marker}")

    def marker_in_terminal():
        output = driver.read_terminal()
        return output if marker in output else None

    output = _wait(marker_in_terminal, timeout=25.0, what="echoed marker in terminal output")
    assert marker in output

    # ── Kill and restart the app; re-acquire the bridge ──────────────────────
    app.restart()
    driver2 = bridge.wait_for_app(timeout=WAIT_APP)
    assert isinstance(driver2.get_state(), dict), "restarted app should re-acquire the bridge"
