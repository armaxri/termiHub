"""Product run: telnet sessions are marked unencrypted (#5749).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Telnet sends everything, the login password included, in
clear text. A telnet tab carries an "Unencrypted" badge, so does the
status-bar telnet chip, and the telnet password prompt says "Telnet sends this
password unencrypted." An SSH tab carries none of them.

The telnet side uses the run's own unprivileged telnet server on loopback
(:mod:`termihub_harness.product_run.telnet_server`) with auto-login and no
saved password, so termiHub asks for it at connect. The SSH side uses the
run's native sshd with key auth.
"""

from __future__ import annotations

import sys

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    SSH_HOST,
    ConnectionsUi,
    PasswordPromptUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.product_run.telnet_server import TelnetServer, TelnetUnavailable

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's servers are POSIX-only"),
]

TELNET_USER = "product-run"
#: A test constant for the run's own server, not a real secret.
TELNET_PASSWORD = "pr-telnet-unencrypted-pw"
BADGE_TEXT = "Unencrypted"
PROMPT_LINE = "Telnet sends this password unencrypted."
CHIP = "status-bar-telnet"
CHIP_BADGE = "status-bar-telnet-unencrypted"
PROMPT_UNENCRYPTED = "password-prompt-unencrypted"


def tab_badge(tab_id: str) -> str:
    """The test id of a tab's "Unencrypted" badge."""
    return f"tab-unencrypted-badge-{tab_id}"


class TestProductRunTelnetUnencrypted(
    ProductRunUi, SshPhaseUi, TerminalUi, TabsUi, SidebarUi, ConnectionsUi, PasswordPromptUi,
    SystemTest,
):
    phase = "Telnet unencrypted"
    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT
    server: TelnetServer | None = None
    tabs: dict[str, str] = {}

    @pytest.fixture(autouse=True)
    def _keep_config(self, request):
        type(self).pytest_config = request.config
        yield

    def tab_of(self, name: str) -> str:
        return self.wait(lambda: self.find_tab(name), what=f"the {name!r} tab")["id"]

    def text_of(self, testid: str) -> str:
        return self.driver.get_text(testid).strip() if self.driver.exists(testid) else ""

    def test_00_telnet_prompt_and_badges(self):
        name = unique_name("pr-telnet-unenc")
        with self.step(
            "telnet.unencrypted.prompt",
            "The telnet password prompt says the password travels unencrypted",
            expect="the 'Telnet password' dialog with the line "
            "'Telnet sends this password unencrypted.' on a warning tint",
            screenshot=False,
        ):
            try:
                srv = TelnetServer(self.recorder.run_dir / "telnet-unencrypted-home",
                                   username=TELNET_USER, password=TELNET_PASSWORD)
                srv.start()
            except TelnetUnavailable as exc:
                pytest.skip(str(exc))
            type(self).server = srv
            self.pytest_config.add_cleanup(srv.stop)
            self.evidence(f"run's telnet server on 127.0.0.1:{srv.port}")
            self.switch_to_connections_sidebar()
            self.open_new_connection_editor()
            self.driver.type("connection-editor-name-input", name)
            self.select_connection_type("telnet")
            self.wait(lambda: self.driver.exists("field-host"), what="the telnet fields")
            self.driver.type("field-host", "127.0.0.1")
            self.driver.type("field-port", str(srv.port))
            self.driver.select("field-authMethod", "password")
            self.wait(lambda: self.driver.exists("field-username"), what="the login fields")
            self.driver.type("field-username", TELNET_USER)
            # No password typed: termiHub asks for it at connect.
            self._click_editor_save(True)
            self.wait(self.password_prompt_open, timeout=30.0, what="the telnet password prompt")
            self.wait(lambda: self.driver.exists(PROMPT_UNENCRYPTED), timeout=5.0,
                      what="the unencrypted line")
            self.shot(label="password-prompt")
            title = self.password_prompt_title()
            line = self.text_of(PROMPT_UNENCRYPTED)
            self.evidence(f"prompt title {title!r}; line {line!r}")
            assert title.startswith("Telnet password"), f"prompt titled {title!r}"
            assert line == PROMPT_LINE, f"the unencrypted line reads {line!r}"
            self.handle_password_prompt(TELNET_PASSWORD)
            self.tabs["telnet"] = self.tab_of(name)
        with self.step(
            "telnet.unencrypted.tab",
            "The telnet tab carries an 'Unencrypted' badge",
            expect="the telnet tab with an 'Unencrypted' badge after its title",
        ):
            self.require("telnet.unencrypted.prompt")
            tab = self.tabs["telnet"]
            self.switch_to_tab(tab)
            self.wait(lambda: self.driver.exists(tab_badge(tab)), timeout=10.0,
                      what="the tab's Unencrypted badge")
            badge = self.text_of(tab_badge(tab))
            self.evidence(f"tab badge: {badge!r}")
            assert badge == BADGE_TEXT, f"the tab badge reads {badge!r}"
        with self.step(
            "telnet.unencrypted.chip",
            "The status-bar telnet chip names host:port and carries the 'Unencrypted' badge",
            expect="the status bar with 'Telnet: 127.0.0.1:<port>' and an 'Unencrypted' badge",
        ):
            self.require("telnet.unencrypted.tab")
            srv = self.server
            assert srv is not None
            self.wait(lambda: self.driver.exists(CHIP_BADGE), timeout=10.0,
                      what="the status-bar Unencrypted badge")
            chip = self.text_of(CHIP)
            badge = self.text_of(CHIP_BADGE)
            self.evidence(f"chip: {chip!r}; badge {badge!r}")
            assert f"Telnet: 127.0.0.1:{srv.port}" in chip, f"telnet chip reads {chip!r}"
            assert badge == BADGE_TEXT, f"the chip badge reads {badge!r}"

    def test_10_ssh_has_no_badge(self):
        name = unique_name("pr-ssh-enc")
        with self.step(
            "ssh.encrypted.no-badge",
            "An SSH tab carries no 'Unencrypted' badge, on the tab or in the status bar",
            expect="an SSH tab and the SSH chip with no 'Unencrypted' badge anywhere",
        ):
            native = self.need_native()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=True,
            )
            self.evidence(f"host-key prompts accepted: {self.accept_all_hostkeys()}")
            tab = self.tab_id_of(name)
            self.wait_connected(tab)
            self.switch_to_tab(tab)
            self.wait(lambda: self.driver.exists("status-bar-ssh"), timeout=10.0,
                      what="the SSH chip")
            self.evidence(f"SSH chip: {self.text_of('status-bar-ssh')!r}")
            assert not self.driver.exists(tab_badge(tab)), "the SSH tab is marked unencrypted"
            assert not self.driver.exists(CHIP_BADGE), "the status bar marks SSH unencrypted"
            assert not self.driver.exists(CHIP), "a telnet chip shows on an SSH tab"
        self.close_all_tabs()
