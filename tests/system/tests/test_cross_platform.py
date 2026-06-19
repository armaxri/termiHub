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
        self.driver.click("connection-list-new-connection")
        self.wait(
            lambda: self.driver.exists("connection-editor-type-select"),
            what="the connection editor",
        )

    def test_typed_command_is_not_echoed_twice(self):
        # MT-LOCAL-09: input must not be doubled back into the terminal.
        self.ensure_terminal()
        marker = "XPLATMARKER"
        self.run_command(f"echo {marker}")
        text = self.wait_for_output(marker)
        assert text.count(marker) <= 2  # once for the command echo, once for output

    def test_no_doubled_output_in_a_split_view(self):
        # MT-LOCAL-10: the same holds for a freshly split panel.
        self.close_all_tabs()
        self.ensure_terminal()
        self.driver.click("terminal-view-split-horizontal")
        self.wait(lambda: self.leaf_count() == 2, what="a split panel")
        # The split opens a fresh, empty active panel — give it a terminal to type in.
        self.ensure_terminal()
        marker = "SPLITMARKER"
        self.run_command(f"echo {marker}")
        text = self.wait_for_output(marker)
        assert text.count(marker) <= 2
        self.close_all_tabs()

    def test_local_shell_field_and_platform_default_shell(self):
        # MT-XPLAT-01: the local type offers a shell field and a platform default.
        self._open_new_connection_editor()
        self.driver.select_option("connection-editor-type-select", "local")
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
        self.driver.select_option("connection-editor-type-select", "serial")
        self.wait(lambda: self.driver.exists("field-port"), what="the serial port field")
        self.close_all_tabs()
