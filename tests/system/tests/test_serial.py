"""Serial infrastructure system tests (ported from tests/e2e/infrastructure/serial*.test.js).

Drives the real app over the test bridge to exercise the Serial connection
editor. No container fixture is needed: these cover the *editor UI* — the port
field and the config selectors (the WebdriverIO SERIAL-01 / SERIAL-05 cases) —
plus, since #854, that an **arbitrary device path** can be typed into the port
field and persisted.

**Live I/O (SERIAL-02 connect / SERIAL-03 echo / SERIAL-04 disconnect, formerly
manual ``MT-SER-09``).** :class:`TestSerialLiveEcho` drives a real serial session
against the host-side ``serial_echo_pair`` fixture (#3682): a ``socat`` PTY pair
with an echo loop on one end. The app runs host-native, so it can open the PTY
directly (the old in-container ``serial-echo`` fixture, whose PTYs lived in a
Docker volume the host app could not reach, was removed in #859). Killing the
fixture's ``socat`` then exercises the live half of the lost-port disconnect
notification (#1824). The fixture skips cleanly where ``socat`` is unavailable
(Windows). It runs on Linux and macOS: on macOS the vendored ``serial2`` falls
back to termios when a PTY rejects the ``IOSSIOSPEED`` baud ioctl (#3701).
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    ConnectionsUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

# Serial config selectors carry these static-schema option values.
SERIAL_CONFIG_FIELDS = [
    "field-baudRate",
    "field-dataBits",
    "field-stopBits",
    "field-parity",
    "field-flowControl",
]

# (testid, non-default value) pairs — each differs from the schema default
# (baudRate 115200, dataBits 8, stopBits 1, parity none, flowControl none).
SERIAL_NON_DEFAULTS = [
    ("field-baudRate", "9600"),
    ("field-dataBits", "7"),
    ("field-stopBits", "2"),
    ("field-parity", "even"),
    ("field-flowControl", "hardware"),
]

# A path the OS does not enumerate as a serial device — the case the old
# detection-only <select> could not target.
VIRTUAL_PORT = "/tmp/termihub-serial-a"

#: Projection region holding per-tab session lifecycle (twin of the frontend
#: ``SESSION_LIFECYCLE_REGION`` in ``src/store/sessionBridge.ts``); its view is
#: ``{"sessions": {<tabId>: {status, exit, …}}}``.
SESSION_LIFECYCLE_REGION = "session-lifecycle"

#: Session statuses that mean the terminal has ended (twin of the frontend
#: ``regionExited`` in ``src/store/sessionBridge.ts``).
EXITED_STATUSES = frozenset({"disconnected", "failed", "sessionLost"})


class TestSerialEditorFields(ConnectionsUi, SystemTest):
    """SERIAL-01: the editor shows the port field and all serial config fields."""

    def test_port_field_is_shown(self):
        self.open_serial_editor()
        # The port field is an editable combobox input (#854), not a <select>.
        assert self.driver.exists("field-port")

    def test_all_config_fields_are_shown(self):
        self.open_serial_editor()
        for field in SERIAL_CONFIG_FIELDS:
            assert self.driver.exists(field), f"missing serial config field: {field}"


class TestSerialConfigSelectors(ConnectionsUi, SystemTest):
    """SERIAL-05: non-default baud/parity/flow/data/stop selections round-trip."""

    def test_non_default_config_round_trips(self):
        self.open_serial_editor()
        for test_id, value in SERIAL_NON_DEFAULTS:
            self.driver.select(test_id, value)
            assert self.driver.get_value(test_id) == value, (
                f"{test_id} did not retain {value!r}"
            )


class TestSerialCustomPort(ConnectionsUi, SystemTest):
    """#854: a non-detected device path can be typed into the port field and saved."""

    def test_typed_path_is_accepted_and_persists(self):
        name = unique_name("serial-path")
        self.open_serial_editor()
        self.driver.type("connection-editor-name-input", name)
        # The old detection-only <select> could not hold a path the OS doesn't
        # enumerate; the editable combobox accepts it and the bridge can type it.
        self.driver.type("field-port", VIRTUAL_PORT)
        assert self.driver.get_value("field-port") == VIRTUAL_PORT

        # …and the typed path persists to the saved connection's config.
        self.driver.click("connection-editor-save")
        conn = self.require_connection(name)
        config = conn.get("config") or {}
        assert config.get("type") == "serial"
        assert (config.get("config") or {}).get("port") == VIRTUAL_PORT


class TestSerialLiveEcho(TerminalUi, TabsUi, ConnectionsUi, SystemTest):
    """MT-SER-09 / MT-SER-10 live half: connect, echo, then lose the port.

    Runs against the host ``socat`` PTY pair from the ``serial_echo_pair``
    fixture: the app connects to ``pair.app_port`` and the fixture echoes every
    byte back, so a marker typed into the terminal must reappear in its output
    (serial has no local echo — only the device can put it there). Killing the
    fixture's ``socat`` then closes the PTY under the app, which must flip the
    tab out of the connected state and show the disconnect overlay (#1824).
    """

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    def _session(self, tab_id: str) -> dict:
        sessions = self.projection_region_cache(SESSION_LIFECYCLE_REGION).get("sessions")
        life = sessions.get(tab_id) if isinstance(sessions, dict) else None
        return life if isinstance(life, dict) else {}

    def _exited(self, tab_id: str) -> bool:
        life = self._session(tab_id)
        return life.get("status") in EXITED_STATUSES or life.get("exit") is not None

    def test_connect_echo_and_disconnect(self, serial_echo_pair):
        name = unique_name("serial-echo")
        self.create_serial_connection(name, port=serial_echo_pair.app_port, connect=True)

        # Connect: a terminal tab titled with the connection name opens and is live.
        tab = self.wait(lambda: self.find_tab(name), what="the serial tab to open")
        tab_id = tab["id"]
        self.wait(self.has_terminal, what="the serial terminal session")

        # Echo: the fixture writes back what the app sends.
        marker = "SERIAL_ECHO_TEST"
        self.run_command(marker)
        assert marker in self.wait_for_output(marker, tab_id=tab_id)
        assert not self._exited(tab_id)

        # Disconnect: the device vanishes; the tab must leave the connected state
        # with the disconnect notice, and stay open for its scrollback.
        serial_echo_pair.kill_socat()
        self.wait(
            lambda: self._exited(tab_id),
            what="the serial tab to be marked disconnected",
        )
        self.wait(
            lambda: self.driver.exists("terminal-disconnect-overlay"),
            what="the disconnect overlay",
        )
        assert self.find_tab(name) is not None
        # The app stays responsive after losing the port.
        assert isinstance(self.driver.get_state(), dict)
