"""Product run, phase 2: SSH — auth methods, host keys, jump host, drops (#5535).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Every check is a recorded step with a window capture and an
``expect`` line for the UI review
(:class:`~termihub_harness.product_run.ProductRunUi`).

The hosts are the run's own (:mod:`termihub_harness.product_run.hosts`): the
native sshd fixture (key auth, a jump-host bastion, server-side drops) and,
when a container runtime already works, the Docker password and two-factor
hosts. A private ``ssh-agent`` holds the fixture's client key for agent auth;
the app never sees the user's agent, keys or ``~/.ssh``. The optional
Raspberry Pi from ``product-run.local.json`` is a read-only real-device leg.

Steps (in order): host-key prompt contents, key login, remembered key,
changed-key warning + Reject, passphrase key, agent auth, password,
keyboard-interactive, jump host, server-side drop + Reconnect, bastion drop +
auto-reconnect, Raspberry Pi.
"""

from __future__ import annotations

import json
import sys
import time

import pytest

from termihub_harness import (
    SSH_HOST,
    SSH_KEY_PASSPHRASE,
    SSH_KEY_PASSPHRASE_PATH,
    SSH_KEY_PATH,
    SSH_MFA_OTP,
    SSH_MFA_PORT,
    SSH_PASSWORD,
    SSH_PASSWORD_PORT,
    SSH_USERNAME,
    ConnectionsUi,
    CredentialStoreUi,
    JumpHostUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    known_hosts,
    unique_name,
)
from termihub_harness.native_ssh import NativeBastionControl, NativeSshServerControl
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.hosts import (
    COMPOSE_MFA,
    COMPOSE_PASSWORD,
    host_key_fingerprint,
)
from termihub_harness.product_run.ssh_steps import (
    HOSTKEY_ACCEPT_REMEMBER,
    HOSTKEY_REJECT,
    SshPhaseUi,
    key_blob,
)

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

MASTER_PASSWORD = "product-run-master-pw"
#: Budget for a dropped tab's auto-reconnect loop (it backs off up to 30 s).
RECONNECT_TIMEOUT = 150.0


class TestProductRunSsh(
    ProductRunUi,
    SshPhaseUi,
    JumpHostUi,
    CredentialStoreUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SystemTest,
):
    phase = "SSH"
    request_timeout = 90.0

    # ── hosts ────────────────────────────────────────────────────────────────
    def test_00_hosts(self):
        with self.step(
            "ssh.hosts",
            "The run's SSH hosts are up (native sshd + bastion; Docker hosts if a runtime works)",
            expect="the main window with an empty tab strip",
        ):
            native = self.need_native()
            t = native.target
            self.evidence(f"native sshd 127.0.0.1:{t.port} as {t.username}, bastion :{t.jump_port}")
            self.evidence(f"session HOME {native.session_home}")
            for service in (COMPOSE_PASSWORD, COMPOSE_MFA):
                self.evidence(f"{service}: {self.hosts.compose.missing(service) or 'up'}")
            self.evidence(f"ssh-agent: {self.hosts.agent_reason or 'private agent with the client key'}")
            assert t.jump_port, "the fixture started no bastion"

    def _trusted(self, port: int) -> list[str]:
        """Fingerprints termiHub remembered for ``127.0.0.1:<port>`` (Accept for host)."""
        path = self.config_dir / "ssh_known_hosts.json"
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        return list(doc.get(f"{SSH_HOST}:{port}", []))

    # ── host key + key auth ──────────────────────────────────────────────────
    def test_01_host_key_and_key_login(self):
        name = unique_name("pr-ssh-key")
        with self.step(
            "ssh.hostkey.prompt",
            "First connect asks to trust the host key, showing host, type and the server's fingerprint",
            expect="the 'trust this host' dialog naming 127.0.0.1 and its port, ED25519 and a SHA256 fingerprint",
            screenshot=False,
        ):
            native = self.need_native()
            port = native.target.port
            want = host_key_fingerprint(native.host_pubkey) if native.host_pubkey else None
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), connect=True,
            )
            shown = self.wait_hostkey_prompt()
            self.shot(label=None)
            self.evidence(f"prompt: {shown}")
            self.evidence(f"server fingerprint (ssh-keygen): {want}")
            assert str(port) in shown["host"], f"host line {shown['host']!r} lacks port {port}"
            assert "ed25519" in shown["type"].lower(), shown["type"]
            assert want and want in shown["fingerprint"], (
                f"prompt fingerprint {shown['fingerprint']!r} is not the server's {want!r}"
            )
            assert "mitm" not in shown, "a first-seen host must not show the changed-key warning"
        with self.step(
            "ssh.key.login",
            "Accept for host: the key-auth session opens a shell",
            expect="an SSH tab with a shell prompt and the echoed marker",
        ):
            self.require("ssh.hostkey.prompt")
            self.answer_hostkey_prompt(HOSTKEY_ACCEPT_REMEMBER)
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            self.evidence(self.echo_round_trip(tab_id, "PR_SSH_KEY_LOGIN_OK"))
            assert not self.password_prompt_open(), "key auth asked for a password"
        with self.step(
            "ssh.hostkey.remembered",
            "The remembered key is in termiHub's trust store; a second connect does not ask again",
            expect="a second SSH tab with a shell and no trust dialog",
        ):
            self.require("ssh.key.login")
            remembered = self.wait(
                lambda: (lambda fps: fps if want in fps else None)(self._trusted(port)),
                timeout=10.0, what="the remembered fingerprint on disk",
            )
            self.evidence(f"ssh_known_hosts.json for 127.0.0.1:{port}: {remembered}")
            assert want in remembered, f"Accept for host did not remember {want}"
            self.connect_connection(name)
            self.wait(lambda: len([t for t in self.tab_ids() if t]) >= 2, what="a second tab")
            second = [t for t in self.tab_ids() if t != tab_id][-1]
            self.wait_connected(second)
            assert not self.hostkey_prompt_open(), "a remembered host asked again"
            self.evidence(self.echo_round_trip(second, "PR_SSH_KEY_SECOND_OK"))
        self.close_all_tabs()

    def test_02_changed_host_key(self):
        name = unique_name("pr-ssh-changed")
        with self.step(
            "ssh.hostkey.changed",
            "A changed host key shows the warning with both fingerprints; Reject connects nothing",
            expect="the host-key dialog with the red 'key has changed' warning and the new fingerprint",
            screenshot=False,
        ):
            native = self.need_native()
            bastion = native.target.jump_port
            algorithm, wrong = key_blob(SSH_KEY_PATH.with_name(SSH_KEY_PATH.name + ".pub"))
            known_hosts.trust(SSH_HOST, bastion, algorithm, wrong)
            try:
                self.switch_to_connections_sidebar()
                self.create_ssh_connection(
                    name, host=SSH_HOST, port=bastion, username=native.target.username,
                    auth_method="key", key_path=str(native.client_key), auto_reconnect=False,
                    connect=True,
                )
                shown = self.wait_hostkey_prompt()
                self.shot(label=None)
                self.evidence(f"prompt: {shown}")
                assert "mitm" in shown, "no changed-key warning for a host whose key differs"
                # The previous key lives in known_hosts here, not termiHub's own
                # store, so the prompt has no previous fingerprint to show.
                self.evidence(f"previous fingerprint shown: {shown.get('previous')!r}")
                self.answer_hostkey_prompt(HOSTKEY_REJECT)
                tab_id = self.tab_id_of(name)
                time.sleep(3.0)
                status = self.session_status(tab_id)
                self.evidence(f"after Reject: session status {status!r}; {self.terminal_tail(tab_id)}")
                assert status != "connected", "Reject still connected"
                kept = known_hosts.known_hosts_file().read_text()
                assert wrong in kept, "Reject replaced the recorded key"
                assert not self._trusted(bastion), "Reject remembered the new key"
                self.shot(label="after-reject")
            finally:
                known_hosts.untrust(SSH_HOST, bastion)
        self.close_all_tabs()

    # ── other auth methods ───────────────────────────────────────────────────
    def test_03_passphrase_key(self):
        name = unique_name("pr-ssh-passphrase")
        with self.step(
            "ssh.passphrase",
            "A passphrase-protected key asks for the passphrase, then connects",
            expect="an SSH tab with a shell after the passphrase dialog closed",
        ):
            native = self.need_native()
            self.setup_master_password_store(MASTER_PASSWORD)
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(SSH_KEY_PASSPHRASE_PATH), save_password=True,
            )
            self.require_connection(name)
            self.connect_connection(name)
            self.wait(self.password_prompt_open, what="the key passphrase prompt")
            self.shot(label="passphrase-prompt")
            self.handle_password_prompt(SSH_KEY_PASSPHRASE)
            self.accept_all_hostkeys(timeout=5.0)
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            self.evidence(self.echo_round_trip(tab_id, "PR_SSH_PASSPHRASE_OK"))
        self.close_all_tabs()

    def test_04_agent_auth(self):
        name = unique_name("pr-ssh-agent")
        with self.step(
            "ssh.agent",
            "Agent auth signs with the run's private ssh-agent; no prompt",
            expect="an SSH tab with a shell, no password or passphrase dialog",
        ):
            native = self.need_native()
            if self.hosts.agent_reason:
                pytest.skip(self.hosts.agent_reason)
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="agent", connect=True,
            )
            self.accept_all_hostkeys(timeout=5.0)
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            assert not self.password_prompt_open(), "agent auth asked for a password"
            self.evidence(self.echo_round_trip(tab_id, "PR_SSH_AGENT_OK"))
        self.close_all_tabs()

    def test_05_password(self):
        name = unique_name("pr-ssh-password")
        with self.step(
            "ssh.password",
            "Password auth: the prompt takes the password and the session opens",
            expect="an SSH tab on the Docker password host with a shell",
        ):
            self.need_compose(COMPOSE_PASSWORD)
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=SSH_PASSWORD_PORT, username=SSH_USERNAME, connect=True
            )
            self.wait(self.password_prompt_open, what="the password prompt")
            self.shot(label="password-prompt")
            self.handle_password_prompt(SSH_PASSWORD)
            self.accept_all_hostkeys(timeout=10.0)
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            self.evidence(self.echo_round_trip(tab_id, "PR_SSH_PASSWORD_OK"))
        self.close_all_tabs()

    def test_06_keyboard_interactive(self):
        name = unique_name("pr-ssh-mfa")
        with self.step(
            "ssh.kbd-interactive",
            "Two-factor host: the SSH authentication dialog asks the code and the session opens",
            expect="the 'SSH authentication' dialog with a Verification code field",
            screenshot=False,
        ):
            self.need_compose(COMPOSE_MFA)
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=SSH_MFA_PORT, username=SSH_USERNAME,
                auth_method="key", key_path=str(SSH_KEY_PATH), connect=True,
            )
            shown = self.wait_kbd_interactive_prompt()
            self.shot(label=None)
            self.evidence(f"dialog: {shown}")
            assert any("code" in label.lower() for label in shown["labels"]), shown
            self.answer_kbd_interactive_prompt(SSH_MFA_OTP)
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id)
            self.evidence(self.echo_round_trip(tab_id, "PR_SSH_MFA_OK"))
            self.shot(label="connected")
        self.close_all_tabs()

    # ── jump host + drops ────────────────────────────────────────────────────
    def test_07_jump_host_and_drops(self):
        jump = unique_name("pr-ssh-jump")
        with self.step(
            "ssh.jump",
            "Jump host: the session reaches the target through the bastion",
            expect="an SSH tab through the jump host with a shell",
        ):
            native = self.need_native()
            t = native.target
            self.switch_to_connections_sidebar()
            self.create_jump_host_connection(
                jump, target_host=SSH_HOST, target_port=t.port, bastion_port=t.jump_port,
                key_path=native.client_key, username=t.username, connect=True,
            )
            accepted = self.accept_all_hostkeys(timeout=15.0)
            self.evidence(f"host-key prompts accepted: {accepted}")
            jump_tab = self.tab_id_of(jump)
            self.wait_connected(jump_tab)
            self.evidence(self.echo_round_trip(jump_tab, "PR_SSH_JUMP_OK"))
            gateways = NativeBastionControl(t).gateway_sessions()
            self.evidence(f"bastion connections: {gateways}")
            assert gateways >= 1, "the session did not ride the bastion"
        with self.step(
            "ssh.drop.overlay",
            "A server-side drop shows the disconnect overlay with Reconnect",
            expect="the SSH tab with the disconnect overlay and a Reconnect button",
        ):
            native = self.need_native()
            name = unique_name("pr-ssh-drop")
            control = NativeSshServerControl(native.target)
            before = control.session_pids()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=SSH_HOST, port=native.target.port, username=native.target.username,
                auth_method="key", key_path=str(native.client_key), auto_reconnect=False,
                connect=True,
            )
            drop_tab = self.tab_id_of(name)
            self.wait_connected(drop_tab)
            self.echo_round_trip(drop_tab, "PR_SSH_BEFORE_DROP")
            new = self.wait(lambda: (control.session_pids() - before) or False, what="its sshd session")
            self.evidence(f"killing sshd session(s) {sorted(new)}")
            control.kill_sessions(new)
            self.wait(lambda: self.driver.exists("terminal-disconnect-overlay"), what="the overlay")
            assert self.driver.exists("terminal-disconnect-reconnect-btn"), "no Reconnect button"
            assert self.find_tab(name) is not None, "the drop closed the tab"
        with self.step(
            "ssh.drop.reconnect",
            "Reconnect opens a fresh session in the same tab",
            expect="the same SSH tab with a live shell again and the marker echoed",
        ):
            self.require("ssh.drop.overlay")
            self.driver.click("terminal-disconnect-reconnect-btn")
            self.wait(lambda: not self.driver.exists("terminal-disconnect-overlay"), what="the overlay to close")
            self.wait_connected(drop_tab)
            self.evidence(self.echo_round_trip(drop_tab, "PR_SSH_RECONNECTED_OK"))
        with self.step(
            "ssh.auto-reconnect",
            "Bastion down: the jump tab notices; bastion back: it reconnects on its own",
            expect="the jump-host tab live again after the bastion restart, scrollback and new output visible",
        ):
            self.require("ssh.jump")
            bastion = NativeBastionControl(self.hosts.native.target)
            self.switch_to_tab(jump_tab)
            try:
                bastion.stop()
                self.wait(
                    lambda: self.session_status(jump_tab) not in (None, "connected"),
                    timeout=60.0, what="the jump tab to notice the drop",
                )
                self.evidence(f"while down: status {self.session_status(jump_tab)!r}")
                self.shot(label="bastion-down")
                bastion.restore()
                self.wait(
                    lambda: self.session_status(jump_tab) == "connected",
                    timeout=RECONNECT_TIMEOUT, what="the jump tab to reconnect",
                )
                self.evidence(self.echo_round_trip(jump_tab, "PR_SSH_AUTO_RECONNECT_OK"))
                # #5620: the buffer held both lines while the pane painted blank —
                # grade what is rendered: the pre-drop line and the new output.
                self.assert_terminal_painted(jump_tab, "PR_SSH_JUMP_OK", "PR_SSH_AUTO_RECONNECT_OK")
            finally:
                bastion.restore()
        self.close_all_tabs()

    # ── real device ──────────────────────────────────────────────────────────
    def test_08_raspberry_pi(self):
        pi = self.inputs.get("raspberry_pi")
        if pi is None:
            self.not_tested("ssh.raspberry-pi", "Raspberry Pi over SSH (real device)",
                            self.inputs.missing("raspberry_pi") or "no input")
            return
        name = unique_name("pr-ssh-pi")
        with self.step(
            "ssh.raspberry-pi",
            "Raspberry Pi: connect, trust its key, run uname (read-only)",
            expect="an SSH tab on the Raspberry Pi showing the uname line",
        ):
            key = str(pi.get("key_path") or "").strip()
            self.switch_to_connections_sidebar()
            self.create_ssh_connection(
                name, host=str(pi["host"]), port=int(pi.get("port") or 22),
                username=str(pi["user"]), auth_method="key" if key else "password",
                key_path=key or None, connect=True,
            )
            if key:
                shown = self.wait_hostkey_prompt(timeout=60.0)
                self.evidence(f"host-key prompt: {shown}")
                self.shot(label="hostkey")
                self.answer_hostkey_prompt(HOSTKEY_ACCEPT_REMEMBER)
            else:
                # No key in the input: the password is the operator's to type.
                self.human_step(
                    "Type the Raspberry Pi's password into the test window's password prompt, "
                    "click Connect, and accept its host key if asked.",
                    "the Pi tab shows a shell",
                )
            tab_id = self.tab_id_of(name)
            self.wait_connected(tab_id, timeout=120.0)
            self.driver.terminal_input("uname -a; echo PR_PI''_DONE", tab_id=tab_id)
            text = self.wait(
                lambda: (lambda t: t if "PR_PI_DONE" in t.replace("PR_PI''_DONE", "") else None)(
                    self.driver.read_terminal(tab_id)
                ),
                timeout=60.0, what="uname output",
            )
            uname = next((ln for ln in text.splitlines() if ln.startswith(("Linux", "Darwin"))), "")
            self.evidence(f"uname: {uname or self.terminal_tail(tab_id)}")
            assert uname, "no uname line from the Pi"
        self.close_all_tabs()
