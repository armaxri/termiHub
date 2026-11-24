"""Product run: connection type icons say the type, and only the type (#5850).

The UI review of run ``20261123T215628Z`` found:

1. **R-069**: SSH rows used a key glyph, the same key the status bar's OS
   Keychain indicator and the credential chooser use for saved passwords.
2. **R-151**: Telnet used a globe, which reads as the web, not a terminal
   protocol.
3. **R-130**: RDP used a plain monitor and VNC a screen-share monitor: close
   but different glyphs for the same concept.
4. **R-148**: the jump-host row showed an unexplained ``⇆`` at its right end.

The grades are pure functions below; the module-level tests run them without
an app in the per-PR lane. The :class:`TestProductRunConnectionTypeIcons` phase
is hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). It saves one connection of each type (none is connected)
and reads each sidebar row's glyph id (``data-icon`` on
``connection-icon-<id>``) and the jump-host marker's accessible name.
"""

from __future__ import annotations

import sys
from typing import Mapping, Optional

import pytest

from termihub_harness import (
    SSH_HOST,
    SSH_KEY_PATH,
    ConnectionsUi,
    JumpHostUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi

#: Glyph ids that mean something other than a connection type. The key is the
#: credential glyph (Keychain indicator, credential chooser); the globe is the
#: web (HTTP sharing); Wi-Fi glyphs are connectivity state (#5622).
RESERVED_GLYPHS: dict[str, str] = {
    "key-round": "saved credentials (the Keychain indicator)",
    "key": "saved credentials",
    "globe": "the web",
    "wifi": "connectivity state",
    "wifi-off": "connectivity state",
}

#: The remote-desktop types, which must share one glyph family.
REMOTE_DESKTOP_TYPES = ("vnc", "rdp")

#: Glyph ids of the monitor family (lucide ``monitor-*`` plus ``screen-share``).
MONITOR_FAMILY_PREFIXES = ("monitor", "screen-share")

#: Bastion host name the live phase types into the jump-host hop.
BASTION = "pr-icons-bastion.example"


def type_icon_problems(icons: Mapping[str, str]) -> list[str]:
    """Problems with the type -> glyph id map read from the sidebar rows.

    Every type must have a glyph, no two types may share one, no type may use a
    reserved glyph, SSH must not be the local-shell ``>_`` glyph, and VNC and
    RDP must both be monitor-family glyphs.
    """
    problems: list[str] = []
    for kind, glyph in icons.items():
        if not glyph:
            problems.append(f"the {kind} row has no glyph id")
        elif glyph in RESERVED_GLYPHS:
            problems.append(f"the {kind} row uses {glyph!r}, which means {RESERVED_GLYPHS[glyph]}")
    seen: dict[str, str] = {}
    for kind, glyph in icons.items():
        if glyph and glyph in seen:
            problems.append(f"the {seen[glyph]} and {kind} rows share the glyph {glyph!r}")
        elif glyph:
            seen[glyph] = kind
    if icons.get("ssh") and icons.get("ssh") == icons.get("local"):
        problems.append("the SSH row uses the local-shell glyph")
    for kind in REMOTE_DESKTOP_TYPES:
        glyph = icons.get(kind)
        if glyph and not glyph.startswith(MONITOR_FAMILY_PREFIXES):
            problems.append(f"the {kind} row glyph {glyph!r} is not a monitor-family glyph")
    return problems


def jump_marker_problems(label: Optional[str], bastion: str) -> list[str]:
    """Problems with the jump-host marker's accessible name / tooltip."""
    if label is None:
        return ["the jump-host row has no marker"]
    if not label.strip():
        return ["the jump-host marker has no accessible name"]
    want = f"Connects via {bastion}"
    if label.strip() != want:
        return [f"the jump-host marker is named {label!r}, want {want!r}"]
    return []


# ── app-free grade tests (per-PR lane) ────────────────────────────────────────

GOOD_ICONS = {
    "local": "terminal",
    "ssh": "square-terminal",
    "telnet": "network",
    "serial": "cable",
    "vnc": "screen-share",
    "rdp": "monitor-cog",
}


def test_distinct_unreserved_icons_pass():
    assert type_icon_problems(GOOD_ICONS) == []


def test_the_old_ssh_key_and_telnet_globe_are_named():
    # Before #5850: SSH drew the credential key, Telnet the web globe.
    old = {**GOOD_ICONS, "ssh": "key-round", "telnet": "globe"}
    problems = type_icon_problems(old)
    assert problems == [
        "the ssh row uses 'key-round', which means saved credentials (the Keychain indicator)",
        "the telnet row uses 'globe', which means the web",
    ]


def test_a_shared_glyph_is_named():
    problems = type_icon_problems({**GOOD_ICONS, "ssh": "terminal"})
    assert "the local and ssh rows share the glyph 'terminal'" in problems
    assert "the SSH row uses the local-shell glyph" in problems


def test_a_remote_desktop_glyph_outside_the_monitor_family_is_named():
    problems = type_icon_problems({**GOOD_ICONS, "rdp": "app-window"})
    assert problems == ["the rdp row glyph 'app-window' is not a monitor-family glyph"]


def test_a_missing_glyph_is_named():
    assert type_icon_problems({**GOOD_ICONS, "telnet": ""}) == ["the telnet row has no glyph id"]


def test_a_named_jump_marker_passes():
    assert jump_marker_problems("Connects via bastion", "bastion") == []


def test_the_old_unlabelled_jump_marker_is_named():
    # Before #5850: a bare '⇆' with no accessible name.
    assert jump_marker_problems("", "bastion") == ["the jump-host marker has no accessible name"]
    assert jump_marker_problems(None, "bastion") == ["the jump-host row has no marker"]


def test_a_jump_marker_naming_the_wrong_host_is_named():
    problems = jump_marker_problems("Via: bastion → app", "bastion")
    assert problems == ["the jump-host marker is named 'Via: bastion → app', want 'Connects via bastion'"]


# ── live phase (hand-triggered product run) ───────────────────────────────────


@pytest.mark.product_run
@pytest.mark.integration
@pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only")
class TestProductRunConnectionTypeIcons(
    ProductRunUi,
    RemoteDesktopUi,
    JumpHostUi,
    SettingsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Connection type icons"
    request_timeout = 90.0

    def _row_icon(self, name: str) -> str:
        """The ``data-icon`` id of the named connection's sidebar glyph."""
        conn_id = self.require_connection(name)["id"]
        testid = f"connection-icon-{conn_id}"
        self.wait(lambda: self.driver.exists(testid), what=f"the {name!r} row glyph")
        return self.driver.get_attribute(testid, "data-icon") or ""

    def test_10_each_type_has_its_own_icon(self):
        tag = unique_name("types").split("-")[-1]
        names = {
            "local": f"Type local {tag}",
            "ssh": f"Type SSH {tag}",
            "telnet": f"Type Telnet {tag}",
            "vnc": f"Type VNC {tag}",
            "rdp": f"Type RDP {tag}",
        }
        with self.step(
            "connection-type-icons.sidebar",
            "Each connection type has its own glyph, none borrowed from credentials or the web",
            expect="#5850: SSH a framed terminal (not the Keychain key), Telnet a network "
            "glyph (not the globe), VNC a screen-share and RDP a monitor with a cog",
        ):
            self.enable_experimental_features()
            self.switch_to_connections_sidebar()
            self.create_local_connection(names["local"])
            self.create_ssh_connection(names["ssh"], host=SSH_HOST, port=22, username="icons")
            self.create_telnet_connection(names["telnet"], host="127.0.0.1", port=23)
            self.create_vnc_connection(names["vnc"], host="127.0.0.1", port=5900, connect=False)
            self.create_rdp_connection(
                names["rdp"], host="127.0.0.1", port=3389, username="icons", connect=False
            )
            icons = {kind: self._row_icon(name) for kind, name in names.items()}
            self.evidence(f"sidebar glyph ids: {icons}")
            self.shot(label="sidebar")
            problems = type_icon_problems(icons)
            assert not problems, problems

    def test_20_jump_host_marker_is_named(self):
        name = unique_name("Type jump")
        with self.step(
            "connection-type-icons.jump",
            "The jump-host marker says which bastion the connection goes through",
            expect=f"#5850: a route glyph on the row named 'Connects via {BASTION}'",
        ):
            self.switch_to_connections_sidebar()
            self.create_jump_host_connection(
                name,
                target_host=SSH_HOST,
                target_port=22,
                bastion_host=BASTION,
                bastion_port=22,
                key_path=SSH_KEY_PATH,
                connect=False,
            )
            conn_id = self.require_connection(name)["id"]
            badge = f"connection-jump-badge-{conn_id}"
            self.wait(lambda: self.driver.exists(badge), what="the jump-host marker")
            label = self.driver.get_attribute(badge, "aria-label")
            self.evidence(f"jump marker name: {label!r}")
            self.shot(label="jump")
            problems = jump_marker_problems(label, BASTION)
            assert not problems, problems
