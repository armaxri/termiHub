"""Product run: each connection type has its own sidebar glyph (#5622).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). The UI review found SSH rows drawn with a Wi-Fi glyph (too
close to the crossed-Wi-Fi "disconnected" overlay) and VNC rows drawn with the
local-shell ``>_`` glyph. This grade saves one SSH, one VNC and one local-shell
connection — none is connected — and reads each sidebar row's glyph id (the
``data-icon`` attribute on ``connection-icon-<id>``): the three must differ,
SSH must not be a Wi-Fi glyph and VNC must not be the terminal glyph.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    SSH_HOST,
    ConnectionsUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]


class TestProductRunTypeIcons(
    ProductRunUi,
    RemoteDesktopUi,
    SettingsUi,
    SidebarUi,
    ConnectionsUi,
    SystemTest,
):
    phase = "Connection-type icons"
    request_timeout = 90.0

    def _row_icon(self, name: str) -> str:
        """The ``data-icon`` id of the named connection's sidebar glyph."""
        conn_id = self.require_connection(name)["id"]
        testid = f"connection-icon-{conn_id}"
        self.wait(lambda: self.driver.exists(testid), what=f"the {name!r} row glyph")
        return self.driver.get_attribute(testid, "data-icon") or ""

    def test_10_sidebar_type_icons_differ(self):
        tag = unique_name("icons").split("-")[-1]
        names = {
            "ssh": f"Icon SSH {tag}",
            "vnc": f"Icon VNC {tag}",
            "local": f"Icon local {tag}",
        }
        with self.step(
            "type-icons.sidebar",
            "SSH, VNC and local-shell rows show three different type glyphs (#5622)",
            expect="#5622: the SSH row shows a key (not Wi-Fi), the VNC row a "
            "remote-desktop screen (not '>_'), the local row the terminal '>_'",
        ):
            self.enable_experimental_features()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(names["ssh"], host=SSH_HOST, port=22, username="icons")
            self.create_vnc_connection(names["vnc"], host="127.0.0.1", port=5900, connect=False)
            self.create_local_connection(names["local"])
            icons = {kind: self._row_icon(name) for kind, name in names.items()}
            self.evidence(f"sidebar glyph ids: {icons}")
            assert len(set(icons.values())) == 3, f"type glyphs are not distinct: {icons}"
            assert "wifi" not in icons["ssh"], f"SSH row uses a Wi-Fi glyph: {icons['ssh']!r}"
            assert icons["vnc"] != "terminal", "VNC row uses the local-shell '>_' glyph"
            assert icons["local"] == "terminal", f"local row glyph is {icons['local']!r}"
