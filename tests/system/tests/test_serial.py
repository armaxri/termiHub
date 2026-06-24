"""Serial infrastructure system tests (ported from tests/e2e/infrastructure/serial*.test.js).

Drives the real app over the test bridge to exercise the Serial connection
editor. No container fixture is needed: these cover the *editor UI* (the port
field and the config selectors), which is what the WebdriverIO SERIAL-01 /
SERIAL-05 cases actually asserted.

**Why the live-I/O cases (SERIAL-02 connect / SERIAL-03 echo / SERIAL-04
disconnect) are not ported as bridge tests.** The serial port field is a
*detection-only* ``<select>`` (``SerialPortField``): it offers only the ports the
OS enumerates via ``serial2::available_ports()`` plus a Linux ``/dev`` prefix
scan. A virtual socat PTY (``/tmp/termihub-serial-a``, symlinked to
``/dev/pts/N``) is **not** enumerated as a serial device, so it never appears as
an option and the bridge ``select`` verb cannot target it — there is no longer a
free-text port input to type a path into. Driving a live serial session against
a virtual port therefore can't go through the real editor UI over the bridge.
This is a genuine OS/library constraint (the epic only changes the *driver*, not
the production UI), so those scenarios stay as **manual tests** — see
``docs/testing.md`` (Infrastructure → Serial). The old WebdriverIO connect tests
only ever asserted "a tab appeared", which they did even when the port stayed
unset; the bridge port keeps the genuinely drivable coverage instead.
"""

from __future__ import annotations

import pytest

from termihub_harness import ConnectionsUi, SystemTest

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


class TestSerialEditorFields(ConnectionsUi, SystemTest):
    """SERIAL-01: the editor shows the port field and all serial config fields."""

    def test_port_field_is_shown(self):
        self.open_serial_editor()
        # The current UI renders the port as a single detection ``<select>``
        # (``field-port``) — the old select-or-input branch collapsed to one.
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


# SERIAL-02 (connect at a baud rate), SERIAL-03 (send/receive echo) and SERIAL-04
# (device disconnect) require selecting a *live* serial port. A virtual socat PTY
# is not enumerated by the detection-only port select, so these run as manual
# tests (docs/testing.md → Infrastructure → Serial) rather than through the
# bridge. Kept as skips so the coverage gap is explicit, mirroring SSH-06/07.
@pytest.mark.skip(reason="live serial port not selectable via detection-only UI (SERIAL-02/03/04); manual")
def test_serial_live_session_is_manual():
    ...
