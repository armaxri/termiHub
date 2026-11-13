"""Product run, phase: remote agent — deploy, connect, shell, files, reconnect (#5536).

Hand-triggered only (``scripts/internal/product-run.sh``; deselected without
``--product-run``). Every check is a recorded step with a window capture and an
``expect`` line for the UI review.

The agent host is the run's own native sshd (key auth, scratch session
``HOME``). The dev agent (``target/{debug,release}/termihub-agent``; the runner
builds it when missing) is deployed through the app's **real** flow: a fresh
remote-agent definition fails to connect (no agent there yet), the error dialog
offers "Set up agent", the setup wizard detects the host's architecture and
uploads the local binary over SFTP into the scratch home. The steps then grade
the installed file on disk, a live connection, a shell on the agent, the file
browser through the agent, disconnect/reconnect, and the update banner.

The update banner can only be raised by the agent's 24 h self-update timer, so
that step injects the backend's ``agent-update-available`` event (the app's
real listener and banner run; see ``AgentUi.announce_agent_update``).

Teardown stops the agent processes the deploy started (found by their
executable path inside the run dir, by PID) before the sshd goes down.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import psutil
import pytest

from termihub_harness import (
    SSH_HOST,
    AgentUi,
    ConnectionsUi,
    FilesUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.colors import contrast
from termihub_harness.orchestrator import REPO_ROOT
from termihub_harness.product_run import ProductRunUi
from termihub_harness.product_run.ssh_steps import SshPhaseUi
from termihub_harness.ui.theme import ThemeUi

pytestmark = [
    pytest.mark.product_run,
    pytest.mark.integration,
    pytest.mark.skipif(sys.platform.startswith("win"), reason="the run's sshd is POSIX-only"),
]

#: Deploy uploads a debug agent (~100 MB) over SFTP and runs the install script.
DEPLOY_TIMEOUT = 300.0
MARKER = "pr-agent-marker.txt"


def agent_binary() -> Path | None:
    """The locally built agent for this machine, newest of debug/release."""
    found = [REPO_ROOT / "target" / kind / "termihub-agent" for kind in ("debug", "release")]
    found = [p for p in found if p.is_file()]
    return max(found, key=lambda p: p.stat().st_mtime) if found else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reap_agents_under(root: Path) -> list[int]:
    """Stop processes whose executable lives under ``root`` (this run's deploy only)."""
    stopped = []
    root_s = str(root.resolve())
    for proc in psutil.process_iter(["pid", "exe"]):
        exe = proc.info.get("exe") or ""
        if exe and os.path.realpath(exe).startswith(root_s + os.sep):
            try:
                proc.terminate()
                stopped.append(proc.pid)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
    psutil.wait_procs([psutil.Process(p) for p in stopped if psutil.pid_exists(p)], timeout=5)
    return stopped


class TestProductRunAgent(
    ProductRunUi,
    SshPhaseUi,
    AgentUi,
    FilesUi,
    SettingsUi,
    TerminalUi,
    TabsUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    ThemeUi,
    SystemTest,
):
    phase = "Remote agent"
    request_timeout = 90.0

    name = unique_name("pr-agent")
    state: dict[str, object] = {}

    @pytest.fixture(autouse=True)
    def _reap_on_exit(self, request):
        native = self.hosts.native
        if native is not None and native.session_home and not self.state.get("reaper"):
            self.state["reaper"] = True
            request.config.add_cleanup(lambda: reap_agents_under(native.session_home))
        yield

    def _install_path(self) -> Path:
        return self.need_native().session_home / ".local" / "bin" / "termihub-agent"

    def _agent_id(self) -> str:
        return self.require_agent(self.name)["id"]

    # ── definition + real deploy ─────────────────────────────────────────────
    def test_00_create_and_deploy(self):
        with self.step(
            "agent.create",
            "A remote agent is defined in the sidebar (key auth to the run's sshd)",
            expect="the Connections sidebar's Remote Agents group listing the new agent, disconnected",
        ):
            native = self.need_native()
            self.open_agents_sidebar()
            self.driver.click(self.NEW_AGENT)
            self.wait(lambda: self.driver.exists(self.EDITOR_NAME), what="the agent editor")
            self.driver.type(self.EDITOR_NAME, self.name)
            self.driver.type("field-host", SSH_HOST)
            self.driver.type("field-port", str(native.target.port))
            self.driver.type("field-username", native.target.username)
            self.driver.select("field-authMethod", "key")
            self.wait(lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key path field")
            self.driver.type(self.KEY_PATH_INPUT, str(native.client_key))
            self.shot(label="editor", expect=self.EDITOR_NAME)
            self.driver.click(self.EDITOR_SAVE)
            agent = self.require_agent(self.name)
            self.evidence(f"agent {agent['id']}: {agent.get('connectionState')}")
        with self.step(
            "agent.connect.not-installed",
            "Connecting before a deploy explains that no agent is installed and offers setup",
            expect="the connection-error dialog for the agent with a 'Set up agent' button",
        ):
            self.require("agent.create")
            binary = agent_binary()
            if binary is None:
                pytest.skip("no built agent (cargo build -p termihub-agent)")
            self.state["binary"] = binary
            self.connect_agent(self.name)
            title = self.wait_connection_error_title()
            self.evidence(f"error: {title!r} / {self.connection_error_message()[:200]!r}")
            assert self.driver.exists(self.ERROR_SETUP_AGENT), "no 'Set up agent' in the error"
        with self.step(
            "agent.deploy",
            "Set up agent: the wizard detects the host and installs the local dev agent over SSH",
            expect="the agent's setup terminal after a finished install, the wizard closed",
        ):
            self.require("agent.connect.not-installed")
            binary = self.state["binary"]
            self.driver.click(self.ERROR_SETUP_AGENT)
            self.wait_setup_ready()
            arch = self.driver.get_text(self.SETUP_ARCH)
            self.evidence(f"detected target: {arch.strip()!r}")
            target = self._install_path()
            self.driver.type(self.SETUP_REMOTE_PATH, str(target))
            self.shot(label="wizard")
            self.start_local_agent_setup(str(binary))
            self.wait(
                lambda: not self.driver.exists(self.SETUP_CANCEL_RUNNING)
                or self.driver.exists("agent-setup-error"),
                timeout=DEPLOY_TIMEOUT, interval=2.0, what="the deploy to finish",
            )
            if self.driver.exists("agent-setup-error"):
                raise AssertionError(f"setup error: {self.driver.get_text('agent-setup-error')}")
            self.wait(lambda: target.is_file(), timeout=30.0, what=f"{target} on the host")
            same = _sha256(target) == _sha256(binary)
            self.evidence(f"installed {target} ({target.stat().st_size} bytes), "
                          f"executable={os.access(target, os.X_OK)}, identical to {binary.name}={same}")
            assert os.access(target, os.X_OK) and same, "the installed agent is not the uploaded binary"

    def test_05_setup_terminal_in_lifecycle(self):
        with self.step(
            "agent.setup.terminal-lifecycle",
            "The setup terminal, opened on the deploy's already-live SSH session, is "
            "listed in the session lifecycle (live status, reconnect on a drop)",
            expect="the agent's setup terminal tab showing the install output",
        ):
            self.require("agent.deploy")
            tab_id = self.tab_id_of(f"Setup: {self.name}")
            # Before #5645 the tab never reached the region: no entry at all.
            status = self.wait(
                lambda: self.session_status(tab_id),
                timeout=30.0,
                what=f"setup tab {tab_id} in the session lifecycle",
            )
            self.evidence(f"setup tab {tab_id}: lifecycle status {status!r}")

    # ── live connection ──────────────────────────────────────────────────────
    def test_10_connect_and_shell(self):
        with self.step(
            "agent.connect",
            "The deployed agent connects and reports its shells",
            expect="the agent row connected (green) and expanded, listing its shells",
        ):
            self.require("agent.deploy")
            self.dismiss_connection_error_if_present()
            self.connect_agent(self.name)
            agent = self.wait_agent_connected(self.name, timeout=90.0)
            caps = agent.get("capabilities") or {}
            self.evidence(f"version {caps.get('agentVersion') or agent.get('agentVersion')}; "
                          f"shells {self.agent_available_shells(self.name)}")
            assert self.agent_available_shells(self.name), "the agent reported no shells"
        with self.step(
            "agent.shell",
            "A shell on the agent runs commands in the host's scratch home",
            expect="a terminal tab on the agent showing the echoed marker and the host's HOME",
        ):
            self.require("agent.connect")
            before = set(self.tab_ids())
            self.new_shell_session(self.name)
            tab = self.wait(lambda: next(iter(set(self.tab_ids()) - before), None),
                            what="the agent shell tab")
            self.state["shell_tab"] = tab
            self.evidence(self.echo_round_trip(tab, "PR_AGENT_SHELL_OK"))
            home = str(self.need_native().session_home)
            self.driver.terminal_input("echo PR_AGENT_HOME=$HOME", tab_id=tab)
            self.wait(lambda: f"PR_AGENT_HOME={home}" in self.driver.read_terminal(tab),
                      timeout=20.0, what="the agent shell's HOME")
            self.evidence(f"agent shell HOME = {home}")

    def test_20_files_via_agent(self):
        with self.step(
            "agent.files",
            "The file browser lists the agent shell's folder through the agent",
            expect="the Files sidebar beside the agent shell, listing pr-agent-marker.txt",
        ):
            self.require("agent.shell")
            tab = self.state["shell_tab"]
            root = self.need_native().session_home / "pr-agent-files"
            root.mkdir(parents=True, exist_ok=True)
            (root / MARKER).write_text("listed through the agent\n", encoding="utf-8")
            self.switch_to_tab(tab)
            # Into the scratch folder first: never list the login user's real home.
            self.run_command(f"cd '{root}'")
            self.echo_round_trip(tab, "PR_AGENT_CD_OK")
            self.switch_to_files_sidebar()
            path = self.wait_for_path_contains("pr-agent-files", timeout=30.0)
            self.evidence(f"browser path: {path}")
            self.wait_for_file_row(MARKER)

    def test_30_disconnect_reconnect(self):
        with self.step(
            "agent.disconnect",
            "Disconnect takes the agent offline",
            expect="the agent row disconnected (no green dot)",
        ):
            self.require("agent.connect")
            self.switch_to_connections_sidebar()
            self.disconnect_agent(self.name)
            self.wait(lambda: self.agent_connection_state(self.name) != "connected",
                      timeout=30.0, what="the agent to disconnect")
            self.evidence(f"state: {self.agent_connection_state(self.name)}")
        with self.step(
            "agent.reconnect",
            "Connecting again restores the agent and its running shell session",
            expect="the agent row connected again with its shell session listed",
        ):
            self.require("agent.disconnect")
            self.connect_agent(self.name)
            self.wait_agent_connected(self.name, timeout=90.0)
            sessions = self.agent_sessions(self._agent_id())
            self.evidence(f"sessions after reconnect: {[s.get('title') or s.get('id') for s in sessions]}")
            tab = self.state.get("shell_tab")
            if tab in self.tab_ids():
                # By design (#4309) a user Disconnect ends the agent's tabs: the
                # tab shows "Agent disconnected" and its Reconnect starts a new
                # session, so reconnect the tab the way a user does first.
                if self.driver.exists("terminal-view-mode-reconnect-btn"):
                    banner = self.driver.get_text("terminal-view-mode-banner").strip()
                    self.evidence(f"tab banner: {banner!r}")
                    self.driver.click("terminal-view-mode-reconnect-btn")
                self.evidence(self.echo_round_trip(tab, "PR_AGENT_AFTER_RECONNECT"))
            else:
                self.evidence("the agent shell tab was closed by the disconnect")
            assert sessions, "the agent lists no session after reconnecting"

    def test_40_update_banner(self):
        with self.step(
            "agent.update-banner",
            "An announced agent update shows the banner under the agent; Dismiss hides it",
            expect="the agent row with the 'update available' banner (Apply Now / Dismiss)",
            screenshot=False,
        ):
            self.require("agent.reconnect")
            agent_id = self._agent_id()
            self.evidence("raised via the agent-update-available event (the agent's 24 h "
                          "self-update timer cannot be driven in a run)")
            self.announce_agent_update(agent_id, available_version="99.0.0")
            text = self.wait_agent_update_banner(agent_id)
            self.evidence(f"banner: {text!r}")
            self.shot(label=None)
            assert "99.0.0" in text, "the banner does not name the new version"
            self.dismiss_agent_update_banner(agent_id)
        try:
            if self.agent_connection_state(self.name) == "connected":
                self.disconnect_agent(self.name)
        except Exception:  # noqa: BLE001 - best-effort tidy-up; the reaper stops the agent
            pass

    def test_50_row_presentation(self):
        """Grade the agent row the UI review flagged (#5621) on a fresh agent."""
        with self.step(
            "agent.row-presentation",
            "A fresh agent's row shows its name as typed, a neutral dot and a Connect action",
            expect="the new mixed-case agent row with a grey dot and 'Connect', not red 'Reconnect'",
        ):
            native = self.need_native()
            # Mixed case so a text-transform on the row cannot go unnoticed.
            name = unique_name("pr-Agent-Case")
            agent = self.create_remote_agent(
                name, host=SSH_HOST, port=native.target.port,
                username=native.target.username, auth_method="key",
            )
            agent_id = agent["id"]
            self.state["fresh_agent"] = name
            name_id, dot_id = f"agent-name-{agent_id}", f"agent-state-{agent_id}"
            self.wait(lambda: self.driver.exists(name_id), what="the fresh agent row")

            shown = self.driver.get_text(name_id)
            transform = self.driver.get_computed_style("text-transform", name_id)
            self.evidence(f"name {shown!r}, text-transform {transform!r}")
            assert shown == name, f"the row shows {shown!r}, not the configured {name!r}"
            assert transform == "none", f"the agent name is text-transformed ({transform})"

            dot_class = self.driver.get_attribute(dot_id, "class") or ""
            dot_label = self.driver.get_attribute(dot_id, "aria-label")
            self.evidence(f"dot class {dot_class!r}, label {dot_label!r}")
            assert "status-dot--disconnected" not in dot_class, "a never-connected agent shows red"
            assert dot_label == "Not connected", f"dot label {dot_label!r}"

            connect_id = f"agent-connect-{agent_id}"
            assert self.driver.exists(connect_id), "no 'Connect' action on the fresh agent"
            label = self.driver.get_text(connect_id).strip()
            self.evidence(f"action {label!r}")
            assert label == "Connect", f"the action reads {label!r}"
            assert not self.driver.exists(f"agent-reconnect-{agent_id}"), "fresh agent offers Reconnect"

            # The empty state (shown while no local connection is saved) must not
            # carry a period orphaned under its settings link.
            if self.driver.exists("connections-empty-state"):
                text = self.driver.get_text("connections-empty-state")
                self.evidence(f"empty state: {text!r}")
                assert not text.rstrip().endswith("features."), "stray period after the link"
                assert not any(line.strip() == "." for line in text.splitlines()), (
                    "the empty state has a '.'-only line"
                )
            else:
                self.evidence("no Connections empty state on screen (connections saved)")

    # ── #5702: inline Connect, compact empty state, link contrast ────────────
    def test_60_sidebar_empty_states_and_inline_connect(self):
        """Grade the #5621 follow-ups (#5702) on the live sidebar."""
        with self.step(
            "agent.connect-inline",
            "A disconnected agent's Connect sits on the agent's name row (#5702, R-010)",
            expect="the fresh agent row with 'Connect' at the end of the name line",
        ):
            name = str(self.state.get("fresh_agent") or "")
            if not name:
                native = self.need_native()
                name = unique_name("pr-Agent-Inline")
                self.create_remote_agent(
                    name, host=SSH_HOST, port=native.target.port,
                    username=native.target.username, auth_method="key",
                )
            agent_id = self.require_agent(name)["id"]
            connect_id = f"agent-connect-{agent_id}"
            self.wait(lambda: self.driver.exists(connect_id), what="the agent's Connect action")
            title = self.driver.measure_element(f"agent-name-{agent_id}")["rect"]
            action = self.driver.measure_element(connect_id)["rect"]
            self.evidence(f"name {title}, connect {action}")
            middle = action["y"] + action["height"] / 2
            assert title["y"] - 1 <= middle <= title["y"] + title["height"] + 1, (
                f"Connect {action} is not on the name row {title}"
            )
            assert action["x"] >= title["x"] + title["width"] - 1, "Connect overlaps the name"

        with self.step(
            "connections.empty-compact",
            "With remote agents listed, the empty Saved group is one compact line (#5702, R-077)",
            expect="'No saved connections. New connection' as a single line above the agents",
        ):
            if self.driver.exists("connections-empty-state"):
                cls = self.driver.get_attribute("connections-empty-state", "class") or ""
                box = self.driver.measure_element("connections-empty-state")["rect"]
                self.evidence(f"empty state class {cls!r}, box {box}")
                assert "connections-empty--compact" in cls, "the full card shows beside agents"
                assert box["height"] <= 48, f"the compact empty state is {box['height']}px tall"
            else:
                self.evidence("no Connections empty state on screen (connections saved)")

        with self.step(
            "themes.solarized-dark.link-contrast",
            "Solarized Dark: empty-state links meet 4.5:1 on the sidebar (#5702, R-139)",
            expect="the app in Solarized Dark",
        ):
            previous = self.current_theme()
            self.set_theme("solarized-dark")
            try:
                link = self.root_color("--text-link")
                sidebar = self.root_color("--sidebar-bg")
                ratio = contrast(link, sidebar)
                self.evidence(f"--text-link {link.hex()} on {sidebar.hex()} = {ratio:.2f}:1")
                assert ratio >= 4.5, f"link text only {ratio:.2f}:1 on the sidebar"
                if self.driver.exists("connections-empty-new-connection"):
                    cls = self.driver.get_attribute("connections-empty-new-connection", "class")
                    if "connections-empty__link" in (cls or ""):
                        shown = self.style_color("color", "connections-empty-new-connection")
                        self.evidence(f"rendered link {shown.hex()}")
                        assert shown.hex() == link.hex(), "the empty-state link is not --text-link"
            finally:
                self.set_theme(previous or "dark")
