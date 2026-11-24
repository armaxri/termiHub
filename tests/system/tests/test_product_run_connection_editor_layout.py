"""The product run's connection-editor layout grade (#5835), without an app.

Type first, no hint that only repeats its label, the "Fill from ~/.ssh/config"
link on Host's label row, one footer row with Test left of Cancel, a VNC/RDP
password right after the username (Save password never without it), the SSH
tunnel toggle right after Host / Port, and no Terminal page for a terminal-less
type. The live measurement runs in the SSH editor-layout and VNC tunnel steps;
this file runs in the normal (per-PR) lane.
"""

from __future__ import annotations

from termihub_harness.product_run.editor_layout import HINTED_FIELDS, REMOTE_DESKTOP_FIELDS
from termihub_harness.product_run.grades import (
    connection_editor_layout_problems,
    hint_restates_label,
)


def _box(y, x=300.0, width=90.0, height=30.0):
    return {"x": x, "y": y, "width": width, "height": height}


def _footer():
    return [
        {"testId": "connection-editor-test", "rect": _box(900, x=300)},
        {"testId": "connection-editor-cancel", "rect": _box(900, x=600)},
        {"testId": "connection-editor-save", "rect": _box(900, x=700)},
        {"testId": "connection-editor-save-connect", "rect": _box(900, x=800)},
    ]


def _ssh():
    return {
        "type": _box(250),
        "name": _box(320),
        "hints": [{"key": "keyPath", "label": "Key path", "hint": "PEM or OpenSSH format, e.g. ~/.ssh/id_ed25519"}],
        "host_label": _box(400, height=18),
        "ssh_import": _box(398, x=700, height=22),
        "footer": _footer(),
        "terminal_page": True,
    }


def _vnc_fields():
    return {
        "port": _box(480),
        "useSshTunnel": _box(560),
        "username": _box(640),
        "password": _box(720),
        "savePassword": _box(800),
    }


def _vnc():
    return {**_ssh(), "fields": _vnc_fields(), "terminal": False, "terminal_page": False}


def test_the_measured_keys_cover_the_graded_fields():
    assert {"host", "port", "username", "authMethod"} <= set(HINTED_FIELDS)
    assert set(REMOTE_DESKTOP_FIELDS) == set(_vnc_fields())


def test_a_good_ssh_editor_passes():
    assert connection_editor_layout_problems(_ssh()) == []


def test_a_good_vnc_editor_passes():
    assert connection_editor_layout_problems(_vnc()) == []


def test_nothing_measured_passes():
    assert connection_editor_layout_problems({}) == []


def test_name_above_type_fails():
    m = _ssh()
    m["type"], m["name"] = _box(320), _box(250)
    assert "Type is not above Name" in connection_editor_layout_problems(m)


def test_the_old_ssh_hints_restate_their_labels():
    # The R-025 hints from run 20261123T215628Z.
    for label, hint in [
        ("Host", "Hostname or IP address of the SSH server"),
        ("Port", "SSH port number"),
        ("Username", "SSH login username"),
        ("Method", "Authentication method to use"),
        ("Key path", "Path to SSH private key file"),
        ("Port", "TCP port number"),
    ]:
        assert hint_restates_label(label, hint), (label, hint)


def test_hints_that_add_something_are_kept():
    for label, hint in [
        ("Port", "Control-channel port (990 for implicit FTPS)"),
        ("Shell", "Remote shell to use (leave empty for default)"),
        ("Save credentials", "Store credentials for automatic login"),
        ("Connect timeout (s)", "Seconds to wait for the connection and SSH handshake before giving up"),
    ]:
        assert not hint_restates_label(label, hint), (label, hint)


def test_a_restating_hint_fails():
    m = _ssh()
    m["hints"].append({"key": "port", "label": "Port", "hint": "SSH port number"})
    problems = connection_editor_layout_problems(m)
    assert any("port:" in p and "only repeats" in p for p in problems), problems


def test_ssh_import_off_the_host_label_row_fails():
    m = _ssh()
    m["ssh_import"] = _box(200, x=300, height=28)
    assert any("Host label row" in p for p in connection_editor_layout_problems(m))


def test_test_right_of_cancel_fails():
    m = _ssh()
    m["footer"][0]["rect"] = _box(900, x=650)
    assert "Test is not left of Cancel" in connection_editor_layout_problems(m)


def test_a_wrapped_footer_fails():
    m = _ssh()
    m["footer"][3]["rect"] = _box(940, x=300)
    assert "the footer buttons are not on one row" in connection_editor_layout_problems(m)


def test_save_password_without_a_password_fails():
    # The R-073 shape: Username, then Save password, no password field.
    m = _vnc()
    del m["fields"]["password"]
    assert "Save password shows without a password field" in connection_editor_layout_problems(m)


def test_a_field_between_username_and_password_fails():
    m = _vnc()
    m["fields"]["connectTimeoutSecs"] = _box(680)
    assert any("Password does not follow Username" in p for p in connection_editor_layout_problems(m))


def test_the_tunnel_toggle_below_username_fails():
    m = _vnc()
    m["fields"]["useSshTunnel"] = _box(900)
    assert any("below Username" in p for p in connection_editor_layout_problems(m))


def test_a_terminal_page_for_vnc_fails():
    m = _vnc()
    m["terminal_page"] = True
    assert "a type without a terminal offers a Terminal page" in connection_editor_layout_problems(m)
