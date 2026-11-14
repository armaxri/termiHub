"""Deploying this machine's locally built agent to the run's native sshd.

Shared by the product-run phases that need a live remote agent: the Remote
agent phase grades each deploy step on its own; other phases (e.g. "Rows show
names", #5769) only need a connected agent and use
:meth:`AgentDeployUi.deploy_and_connect_agent`.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import psutil
import pytest

from termihub_harness import SSH_HOST
from termihub_harness.orchestrator import REPO_ROOT

#: Deploy uploads a debug agent (~100 MB) over SFTP and runs the install script.
DEPLOY_TIMEOUT = 300.0


def agent_binary() -> Path | None:
    """The locally built agent for this machine, newest of debug/release."""
    found = [REPO_ROOT / "target" / kind / "termihub-agent" for kind in ("debug", "release")]
    found = [p for p in found if p.is_file()]
    return max(found, key=lambda p: p.stat().st_mtime) if found else None


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


class AgentDeployUi:
    """Create, deploy and connect a remote agent on the run's native sshd.

    Mixed into a product-run phase together with ``SshPhaseUi`` (for
    :meth:`need_native`), ``AgentUi`` and ``ConnectionsUi`` (for
    ``KEY_PATH_INPUT``).
    """

    def deploy_and_connect_agent(self, name: str, *, install_dir: str) -> dict[str, Any]:
        """Define agent ``name`` (key auth), install the local build, connect it.

        The agent is installed to ``<session home>/<install_dir>/termihub-agent``
        on the native host, so it does not clash with another phase's deploy.
        Skips the step when there is no native sshd or no built agent. Returns
        the connected agent.
        """
        native = self.need_native()
        binary = agent_binary()
        if binary is None:
            raise pytest.skip.Exception("no built agent (cargo build -p termihub-agent)")
        self.open_agents_sidebar()
        self.driver.click(self.NEW_AGENT)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME), what="the agent editor")
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.type("field-host", SSH_HOST)
        self.driver.type("field-port", str(native.target.port))
        self.driver.type("field-username", native.target.username)
        self.driver.select("field-authMethod", "key")
        self.wait(lambda: self.driver.exists(self.KEY_PATH_INPUT), what="the key path field")
        self.driver.type(self.KEY_PATH_INPUT, str(native.client_key))
        self.driver.click(self.EDITOR_SAVE)
        self.require_agent(name)

        self.connect_agent(name)
        self.wait_connection_error_title()
        self.wait(
            lambda: self.driver.exists(self.ERROR_SETUP_AGENT), what="'Set up agent' in the error"
        )
        self.driver.click(self.ERROR_SETUP_AGENT)
        self.wait_setup_ready()
        target = native.session_home / install_dir / "termihub-agent"
        self.driver.type(self.SETUP_REMOTE_PATH, str(target))
        self.start_local_agent_setup(str(binary))
        self.wait(
            lambda: not self.driver.exists(self.SETUP_CANCEL_RUNNING)
            or self.driver.exists("agent-setup-error"),
            timeout=DEPLOY_TIMEOUT,
            interval=2.0,
            what="the deploy to finish",
        )
        if self.driver.exists("agent-setup-error"):
            raise AssertionError(f"setup error: {self.driver.get_text('agent-setup-error')}")
        self.wait(lambda: target.is_file(), timeout=30.0, what=f"{target} on the host")

        self.dismiss_connection_error_if_present()
        self.connect_agent(name)
        return self.wait_agent_connected(name, timeout=90.0)
