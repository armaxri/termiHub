"""Guided-manual tests on real hardware and real remote hosts (#919, epic #913).

These need something no CI container provides: a physical serial adapter, a
real Windows machine, a Raspberry Pi. They run on the maintainer's hardware
with ``./pytest.sh --manual -k real_hardware -s``. The harness drives the app
(builds the connection, deploys and connects the agent, opens the sessions,
types the commands and asserts their output) and the operator only provides
the device or host and confirms what the harness cannot see.

The real device or host is named through an environment variable, parsed by
:mod:`termihub_harness.guided` (unit-tested in ``test_guided_helpers.py``):

| Variable | Example | Used by |
| --- | --- | --- |
| ``TERMIHUB_SERIAL_DEVICE`` | ``/dev/ttyUSB0``, ``COM3`` | physical serial loopback |
| ``TERMIHUB_REAL_AGENT_HOST`` | ``pi@raspberrypi.local:22`` | agent deploy + sessions on a real host |
| ``TERMIHUB_WINDOWS_AGENT_HOST`` | ``me@winbox:22`` | Docker session from a Windows agent |

A test whose variable is unset skips and says what to set.

**What CI already covers (and so is not repeated here).** The #919 list was
reconciled against the automated lanes:

- MT-SER-09 live serial I/O: ``test_serial.py::TestSerialLiveEcho`` against
  the host ``socat`` echo pair (#3682; Linux and macOS). Only the physical
  adapter stays here.
- MT-AGENT-15 native MSVC agent build: ``agent.yml`` ``build-windows`` job
  (``build-agents.cmd --native``, #3685).
- MT-AGENT-18/19/20 deploy, install and ``--stdio`` connect through a cmd.exe
  and a PowerShell DefaultShell, and MT-AGENT-24 named-pipe reattach: the
  *Windows SSH Host* workflow (``windows-ssh-host.yml``, jobs "Agent deploy to
  Windows SSH host (cmd|powershell)") running
  ``windows_ssh_host_tests::{cmd,powershell}_default_shell_deploy_install_connect_reattach``.
- MT-AGENT-21 Windows agent in the release assets:
  ``release-windows-smoke.yml``.
- MT-AGENT-22/23 PowerShell and cmd.exe ConPTY sessions through the agent:
  ``agent/tests/local_agent_integration.rs``
  (``live_agent_tcp_windows_powershell_session_echo_resize_close_reaps_shell``)
  and ``core/src/backends/local_shell.rs``
  (``windows_cmd_spawn_echo_resize_teardown``) on the Windows CI leg.
- MT-AGENT-25 file browser on a Windows agent: ``core/src/files/local.rs``
  tilde list/stat and read/write tests on the Windows CI leg.
- MT-AGENT-26/27 SSH session and default-key / ssh-agent auth from a Windows
  agent, and the engine half of MT-AGENT-28: ``native_sshd_agent_backends.rs``
  in the same Windows SSH Host workflow.

What stays here:

- **Physical serial adapter** (MT-SER-09, physical variant): a USB-serial
  adapter with TX and RX bridged. The harness asserts the echo; the operator
  only unplugs the adapter, and the harness asserts the disconnect.
- **Agent on a real remote host** (release residue of #470/#473/#474/#477): the
  GUI deploys the agent to a real Windows notebook or Raspberry Pi, opens a
  shell session (ConPTY on Windows), and a persistent session survives a
  disconnect. CI covers each mechanism against a loopback host on the runner;
  this is the end-to-end walk on real hardware and a real network.
- **MT-AGENT-28** (container half): a Docker container session through a
  Windows-hosted agent. GitHub's Windows runners only run Windows containers.
- **MT-SER-02**: bundled Nerd Font glyphs on a clean Windows install.
"""

from __future__ import annotations

import os

import pytest

from termihub_harness import (
    LIVE_CONNECT_REQUEST_TIMEOUT,
    AgentUi,
    ConnectionsUi,
    ManualUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    SystemTest,
    TabsUi,
    TerminalUi,
    unique_name,
)
from termihub_harness.guided import (
    REAL_AGENT_HOST_ENV,
    SERIAL_DEVICE_ENV,
    WINDOWS_AGENT_HOST_ENV,
    HostSpec,
    host_from_env,
    missing_env_reason,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

#: A real-host connect waits for the operator to answer the password and
#: host-key prompts, then for the upload of the agent binary over a real link.
_REAL_CONNECT_TIMEOUT = 300.0


def _require_host(var: str, example: str, purpose: str) -> HostSpec:
    spec = host_from_env(var)
    if spec is None:
        pytest.skip(missing_env_reason(var, example, purpose))
    return spec


class TestRealHardware(
    TerminalUi,
    TabsUi,
    ConnectionsUi,
    AgentUi,
    PasswordPromptUi,
    SettingsUi,
    SidebarUi,
    ManualUi,
    SystemTest,
):
    """Real device / real host: harness drives and asserts, operator provides."""

    request_timeout = LIVE_CONNECT_REQUEST_TIMEOUT

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _connect_real_agent(self, spec: HostSpec, label: str) -> dict:
        """Create an agent for ``spec``, connect, and let the operator answer prompts.

        The password is the operator's, so the harness does not answer the
        prompt. If the host has no agent yet the app offers the setup wizard;
        the operator accepts it and the harness waits for the deploy.
        """
        self.enable_experimental_features()
        name = unique_name(label)
        self.create_remote_agent(name, host=spec.host, port=spec.port, username=spec.user)
        self.connect_agent(name)
        self.manual_step(
            f"termiHub is connecting agent {name!r} to {spec}. Answer the password "
            "and host-key prompts. If it offers to install the agent, accept and "
            "let the setup finish.",
            "The agent reaches 'connected' in the sidebar (the harness checks this "
            "next; answer y once you have answered the prompts).",
        )
        return self.wait_agent_connected(name, timeout=_REAL_CONNECT_TIMEOUT)

    def _open_agent_shell(self, agent_name: str) -> str:
        before = self.tab_count()
        self.new_shell_session(agent_name)
        self.wait(lambda: self.tab_count() > before, what="the agent shell tab")
        self.wait(self.has_terminal, what="the agent shell terminal")
        return self.active_tab()["id"]

    # ── Physical serial adapter (MT-SER-09, physical variant) ─────────────────
    def test_physical_serial_loopback_echo_and_unplug(self):
        """A real USB-serial adapter with TX↔RX bridged echoes what the app sends;
        unplugging it disconnects the tab without hanging the app."""
        device = os.environ.get(SERIAL_DEVICE_ENV, "").strip()
        if not device:
            pytest.skip(
                missing_env_reason(
                    SERIAL_DEVICE_ENV, "/dev/ttyUSB0", "a USB-serial adapter with TX and RX bridged"
                )
            )
        self.close_all_tabs()
        name = unique_name("serial-physical")
        self.create_serial_connection(name, port=device, connect=True)
        tab = self.wait(lambda: self.find_tab(name), what="the serial tab")
        self.wait(self.has_terminal, what="the serial session")

        # Serial has no local echo: only the adapter's loopback can return it.
        marker = unique_name("SERIAL_LOOP")
        self.run_command(marker)
        assert marker in self.wait_for_output(marker, tab_id=tab["id"])

        self.manual_step(
            f"Unplug the adapter at {device} now.",
            "Within a few seconds the tab shows the disconnect notice and the app "
            "stays responsive (the harness checks both next).",
        )
        self.wait(
            lambda: self.terminal_session_exited(tab["id"]),
            timeout=30.0,
            what="the serial tab to be marked disconnected",
        )
        assert self.driver.exists("terminal-disconnect-overlay")
        assert isinstance(self.driver.get_state(), dict)

    # ── Agent on a real host (#470/#473/#474/#477 residue) ───────────────────
    def test_real_host_agent_deploy_shell_and_persistent_reattach(self):
        """Deploy to a real Windows notebook or Pi, run a shell, survive a drop."""
        spec = _require_host(
            REAL_AGENT_HOST_ENV, "pi@raspberrypi.local:22", "a real Windows or Linux/arm64 host"
        )
        self.close_all_tabs()
        agent = self._connect_real_agent(spec, "real-agent")
        shells = self.agent_available_shells(agent["name"])
        assert shells, "the real agent reported no shells"

        tab_id = self._open_agent_shell(agent["name"])
        marker = unique_name("real-agent-echo")
        self.run_command(f"echo {marker}")
        assert marker in self.wait_for_output(marker, tab_id=tab_id)
        self.manual_observe(
            f"The agent reports these shells: {', '.join(shells)}. A shell tab is "
            "open on the real host. Resize the termiHub window and run a full-screen "
            "program there (Windows: `Get-Process | more` in PowerShell; Linux: `top`).",
            "The output reflows to the new size and the program draws correctly; on "
            "Windows the PowerShell and cmd.exe shells are both listed.",
        )

        definition = self.create_agent_definition(
            agent["name"], unique_name("real-persist"), persistent=True
        )
        self.start_persistent_session(definition["id"])
        self.wait_persistent_running(agent["id"], definition["id"])
        self.disconnect_agent(agent["name"])
        self.wait(
            lambda: self.agent_connection_state(agent["name"]) == "disconnected",
            what="the agent to disconnect",
        )
        self.connect_agent(agent["name"])
        self.manual_step(
            "termiHub is reconnecting the agent. Answer the password prompt if asked.",
            "The agent reconnects.",
        )
        self.wait_agent_connected(agent["name"], timeout=_REAL_CONNECT_TIMEOUT)
        self.wait(
            lambda: any(
                s.get("definitionId") == definition["id"]
                for s in self.agent_sessions(agent["id"])
            ),
            timeout=60.0,
            what="the persistent session to survive the reconnect",
        )
        self.disconnect_agent(agent["name"])

    # ── MT-AGENT-28: Docker container session from a Windows agent ───────────
    def test_windows_agent_docker_container_session(self):
        """MT-AGENT-28: a Docker container session through a Windows-hosted agent."""
        spec = _require_host(
            WINDOWS_AGENT_HOST_ENV,
            "me@winbox:22",
            "a Windows host with Docker Desktop (Linux containers) or a Podman machine",
        )
        self.close_all_tabs()
        agent = self._connect_real_agent(spec, "win-docker-agent")
        self.manual_step(
            f"Under agent {agent['name']!r}, choose New Connection, pick the Docker "
            "type with image `alpine` and runtime Auto, turn on Remove on Exit, and "
            "open it. In the container run `ls /`, resize the pane, and open the "
            "file browser for the tab.",
            "The container shell is interactive, `ls /` lists directories, the resize "
            "does not end the session, and the file browser lists the container's /.",
        )
        self.close_all_tabs()
        self.manual_step(
            "The harness closed the tab. On the Windows host run `docker ps -a`.",
            "The alpine container is gone (Remove on Exit) and no session is left "
            "running under the agent.",
        )
        self.disconnect_agent(agent["name"])

    # ── MT-SER-02: bundled Nerd Font on a clean Windows install ──────────────
    @pytest.mark.manual(platforms=["windows"])
    def test_bundled_nerd_font_on_clean_windows(self):
        """MT-SER-02: glyphs render on a Windows machine with no Nerd Font installed."""
        self.close_all_tabs()
        self.ensure_terminal()
        # The marker is concatenated so only the output (not the echoed command) holds it.
        self.run_command(
            "Write-Output ('NF-' + 'OK [' + [char]0xE0A0 + ' ' + [char]0xE0B0 + ' ' "
            "+ [char]0xF07C + ']')"
        )
        self.wait_for_output("NF-OK")
        self.manual_observe(
            "This machine has no Nerd Font installed (check Settings > Personalization "
            "> Fonts). Look at the glyphs between the brackets.",
            "A branch, a powerline arrow and a folder icon render from the bundled font; "
            "no empty boxes.",
        )
