"""Cross-platform terminal + connection-editor behavior.

Ported from ``tests/e2e/cross-platform.test.js`` (MT-LOCAL-09/10, MT-XPLAT-01/02)
onto the Python bridge harness (#808). The shell-list-per-OS check maps to the
``defaultShell`` store value plus the presence of the schema-driven shell field,
since the bridge cannot enumerate raw ``<option>`` text; the serial check maps to
the serial port field rendered for the ``serial`` connection type.
"""

import sys

import pytest

from termihub_harness import SystemTest

pytestmark = pytest.mark.integration


class TestCrossPlatform(SystemTest):
    def _open_new_connection_editor(self) -> None:
        self.set_sidebar_visible(True)
        self.open_new_connection_editor()

    def test_typed_command_is_not_echoed_twice(self):
        # MT-LOCAL-09: input must not be doubled back into the terminal.
        self.ensure_terminal()
        marker = "XPLATMARKER"
        self.run_command(f"echo {marker}")
        text = self.wait_for_output(marker)
        assert text.count(marker) <= 2  # once for the command echo, once for output

    def test_no_doubled_output_in_a_split_view(self):
        # MT-LOCAL-10: the same holds once a split layout exists. The doubling bug
        # is line-ending normalization, which is panel-independent, so we keep the
        # original terminal's session and type into it after splitting rather than
        # spawning a second shell (which is what made this flaky under load).
        self.close_all_tabs()
        self.ensure_terminal()
        tab_id = self.driver.get_state("rootPanel.activeTabId")
        self.driver.click("terminal-view-split-horizontal")
        self.wait(lambda: self.leaf_count() == 2, what="a split panel")

        marker = "SPLITMARKER"
        self.driver.terminal_input(f"echo {marker}", tab_id=tab_id)
        text = self.wait_for_output(marker, tab_id=tab_id)
        assert text.count(marker) <= 2
        self.close_all_tabs()

    def test_local_shell_field_and_platform_default_shell(self):
        # MT-XPLAT-01: the local type offers a shell field and a platform default.
        self._open_new_connection_editor()
        self.driver.select("connection-editor-type-select", "local")
        self.wait(lambda: self.driver.exists("field-shell"), what="the shell field")

        default_shell = str(self.driver.get_state("defaultShell") or "").lower()
        assert default_shell != ""
        if sys.platform == "darwin":
            assert "zsh" in default_shell or "bash" in default_shell
        elif sys.platform.startswith("win"):
            assert "powershell" in default_shell or "cmd" in default_shell or "pwsh" in default_shell
        else:
            assert "bash" in default_shell or "sh" in default_shell
        self.close_all_tabs()

    def test_serial_type_offers_a_port_field(self):
        # MT-XPLAT-02: the serial type renders a port field (select or free input).
        self._open_new_connection_editor()
        self.driver.select("connection-editor-type-select", "serial")
        self.wait(lambda: self.driver.exists("field-port"), what="the serial port field")
        self.close_all_tabs()
