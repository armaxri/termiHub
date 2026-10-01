"""SSH keyboard-interactive / OTP prompts, app level (#3371, #3377, #4005).

The core suite (``core/tests/ssh_mfa.rs``) proves the client's
keyboard-interactive *protocol* against a real OpenSSH; this module proves the
**app** end of it: the global "SSH Authentication" dialog
(``SshKeyboardInteractivePrompt``) that every SSH connect path raises when a
server asks a keyboard-interactive question, and that answering it connects.

Fixtures:

* ``ssh-mfa`` (2216, #3384) — real two-factor OpenSSH: a key (or password) is a
  *partial* success, then keyboard-interactive asks ``Verification code:`` (fixed
  code ``424242``). Drives the terminal connect, **Test**, and the ProxyJump hop.
* ``remote-agent-kbdint`` (2217) — the deployed-agent image behind a
  keyboard-interactive-only sshd (PAM asks ``Password:`` as a KI prompt). Drives
  a remote agent whose auth method is "Keyboard-Interactive" (#3377).

Each connect is also checked **server-side**: the fixture's sshd log (``sshd -e``)
must gain an ``Accepted keyboard-interactive/pam`` line, so a dialog that merely
closes without authenticating cannot pass.
"""

from __future__ import annotations

import pytest

from termihub_harness import (
    REMOTE_AGENT_KBDINT_PORT,
    SSH_HOST,
    SSH_KEY_PATH,
    SSH_MFA_CONTAINER_SUFFIX,
    SSH_MFA_OTP,
    SSH_MFA_PORT,
    SSH_PASSWORD,
    SSH_USERNAME,
    AgentUi,
    ConnectionsUi,
    ContainerControl,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)

pytestmark = pytest.mark.integration

#: The sshd log line of a completed keyboard-interactive (PAM) authentication.
ACCEPTED_KI = f"Accepted keyboard-interactive/pam for {SSH_USERNAME}"
#: ``ssh-keys`` as the ProxyJump *target*: reached from the ``ssh-mfa`` bastion
#: by its compose service name on the shared ``test-net``, on its in-container port.
JUMP_TARGET_HOST = "ssh-keys"
JUMP_TARGET_PORT = 22
#: ``container_name`` suffix of the keyboard-interactive-only agent fixture.
REMOTE_AGENT_KBDINT_CONTAINER_SUFFIX = "remote-agent-kbdint"


def _accepted_ki_count(container: ContainerControl) -> int:
    return container.logs().count(ACCEPTED_KI)


@pytest.mark.usefixtures("ssh_mfa_fixtures")
class TestSshKeyboardInteractive(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
):
    """Key + one-time code against the two-factor ``ssh-mfa`` fixture."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        if self.kbd_interactive_prompt_open():
            self.cancel_kbd_interactive_prompt()
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    @pytest.fixture
    def mfa_container(self) -> ContainerControl:
        return ContainerControl(SSH_MFA_CONTAINER_SUFFIX)

    def _assert_otp_dialog(self, *, port: int = SSH_MFA_PORT) -> None:
        """The dialog is up for the ssh-mfa host and asks the verification code."""
        shown = self.wait_kbd_interactive_prompt()
        assert f"{SSH_USERNAME}@{SSH_HOST}:{port}" in shown["target"], shown
        assert len(shown["labels"]) == 1, shown
        assert "Verification code" in shown["labels"][0], shown

    def _assert_shell_works(self) -> None:
        self.accept_host_key_prompt()
        self.wait(self.has_terminal, what="the SSH terminal session")
        marker = unique_name("ki-echo")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker)

    def test_dialog_answer_connects_terminal(self, mfa_container):
        """KI-01: Save & Connect with a key raises the OTP dialog; the right code
        lands a working shell and the server logs a keyboard-interactive accept."""
        before = _accepted_ki_count(mfa_container)
        self.create_ssh_connection(
            unique_name("ki-terminal"),
            host=SSH_HOST,
            port=SSH_MFA_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=True,
        )
        self._assert_otp_dialog()
        self.answer_kbd_interactive_prompt(SSH_MFA_OTP)
        self._assert_shell_works()
        assert self.wait(
            lambda: _accepted_ki_count(mfa_container) > before,
            what="sshd to log the keyboard-interactive accept",
        )

    def test_test_connection_shows_dialog(self, mfa_container):
        """KI-02: **Test** on an unsaved form raises the same dialog; answering it
        completes the probe (server-side accept) without saving or opening a tab."""
        name = unique_name("ki-test-conn")
        before = _accepted_ki_count(mfa_container)
        self.fill_ssh_connection_form(
            name,
            host=SSH_HOST,
            port=SSH_MFA_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
        )
        self.wait(
            lambda: self.driver.get_attribute("connection-editor-test", "data-invalid") is None,
            what="the connection form to report itself valid",
        )
        self.driver.click("connection-editor-test")
        self._assert_otp_dialog()
        self.answer_kbd_interactive_prompt(SSH_MFA_OTP)
        assert self.wait(
            lambda: _accepted_ki_count(mfa_container) > before,
            what="sshd to log the Test probe's keyboard-interactive accept",
        )
        # The probe finishes (its Cancel Test affordance goes away) and nothing
        # was saved.
        self.wait(
            lambda: not self.driver.exists("connection-editor-test-cancel"),
            what="the connection test to finish",
        )
        assert self.find_connection(name) is None

    def test_proxyjump_hop_shows_dialog(self, mfa_container):
        """KI-03: a ProxyJump chain whose bastion is the two-factor host raises the
        dialog for the *hop* (the bastion's address, not the target's); answering
        it carries the connect through to the key-auth target behind it."""
        hop = unique_name("ki-hop")
        self.create_ssh_connection(
            hop,
            host=SSH_HOST,
            port=SSH_MFA_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
            connect=False,
        )
        hop_id = self.require_connection(hop)["id"]
        before = _accepted_ki_count(mfa_container)

        self.fill_ssh_connection_form(
            unique_name("ki-jump-target"),
            host=JUMP_TARGET_HOST,
            port=JUMP_TARGET_PORT,
            username=SSH_USERNAME,
            auth_method="key",
            key_path=str(SSH_KEY_PATH),
        )
        self.driver.click("jump-host-enabled")
        self.wait(
            lambda: self.driver.exists("jump-host-source-saved-0"),
            what="the jump-host hop editor",
        )
        self.driver.click("jump-host-source-saved-0")
        self.wait(
            lambda: self._try_select("jump-host-connection-0", hop_id),
            what="the saved hop connection to be selectable",
        )
        self._click_editor_save(True)

        self._assert_otp_dialog()
        self.answer_kbd_interactive_prompt(SSH_MFA_OTP)
        self._assert_shell_works()
        assert self.wait(
            lambda: _accepted_ki_count(mfa_container) > before,
            what="the bastion's sshd to log the hop's keyboard-interactive accept",
        )


@pytest.mark.usefixtures("remote_agent_kbdint_fixtures")
class TestRemoteAgentKeyboardInteractive(
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    TabsUi,
    TerminalUi,
    SystemTest,
):
    """A remote agent whose SSH transport authenticates keyboard-interactively."""

    @pytest.fixture(autouse=True)
    def _cleanup_between_tests(self):
        yield
        if self.kbd_interactive_prompt_open():
            self.cancel_kbd_interactive_prompt()
        self.dismiss_connection_error_if_present()
        for agent in self.remote_agents():
            if agent.get("connectionState") not in (None, "disconnected"):
                self.disconnect_agent(agent["name"])
        self.close_all_tabs()
        self.switch_to_connections_sidebar()

    def test_agent_connect_via_keyboard_interactive(self):
        """KI-04: connecting an agent with the "Keyboard-Interactive" method raises
        the dialog with the server's ``Password:`` question (no password prompt
        first); answering it connects the agent and its shells come up."""
        container = ContainerControl(REMOTE_AGENT_KBDINT_CONTAINER_SUFFIX)
        before = _accepted_ki_count(container)
        name = unique_name("agent-ki")
        self.create_remote_agent(
            name,
            host=SSH_HOST,
            port=REMOTE_AGENT_KBDINT_PORT,
            username=SSH_USERNAME,
            auth_method="keyboard-interactive",
        )
        self.connect_agent(name)

        shown = self.wait_kbd_interactive_prompt()
        assert f"{SSH_USERNAME}@{SSH_HOST}:{REMOTE_AGENT_KBDINT_PORT}" in shown["target"], shown
        assert shown["labels"] and "Password" in shown["labels"][0], shown
        assert not self.password_prompt_open(), "KI auth must not raise the password prompt"
        self.answer_kbd_interactive_prompt(SSH_PASSWORD)

        self.wait_agent_connected(name)
        assert self.agent_available_shells(name), "connected agent reported no shells"
        assert self.wait(
            lambda: _accepted_ki_count(container) > before,
            what="sshd to log the agent transport's keyboard-interactive accept",
        )
