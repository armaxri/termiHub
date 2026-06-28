"""Serial infrastructure system tests (ported from tests/e2e/infrastructure/serial*.test.js).

Drives the real app over the test bridge to exercise the Serial connection
editor. No container fixture is needed: these cover the *editor UI* — the port
field and the config selectors (the WebdriverIO SERIAL-01 / SERIAL-05 cases) —
plus, since #854, that an **arbitrary device path** can be typed into the port
field and persisted.

**Why the live-I/O cases (SERIAL-02 connect / SERIAL-03 echo / SERIAL-04
disconnect) still run as manual tests.** The port field is now an editable
combobox, so the bridge *can* set a virtual socat PTY path (#854) — that is no
longer the blocker. What's still missing is a **host-side socat echo fixture**
wired into the harness: the app runs host-native, and the host virtual-serial
setup currently lives only in `scripts/test-system.sh` (the unreachable
in-container `serial-echo` fixture, whose PTYs lived in an isolated Docker
volume the host app could not reach, was removed in #859). Until that fixture is
part of the harness, live send/receive stays manual — see `docs/testing.md` →
Infrastructure → Serial (`MT-SER-09`).
"""

from __future__ import annotations

import pytest

from termihub_harness import ConnectionsUi, SystemTest, unique_name

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
