"""App-quit tears down every live SFTP session — no server-side orphan (#1268).

System-level complement to the ``SftpManager::close_all()`` unit test that landed
in #1244 (the poison-safe drain) and the keyed-session work in #1241. Those prove
the drain in isolation; this proves the **end-to-end invariant** on the real built
app: a live SFTP session is a real, dedicated SSH connection on the server, and
after the app quits **no orphaned SSH+SFTP connection remains** (audit gap L2 in
``docs/audits/sftp-file-browser-state-machine.md``).

How the server side is observed
-------------------------------
termiHub's SFTP browser opens a **dedicated** SSH connection per session
(``SftpSession::open`` → ``connect_and_authenticate``, ``src-tauri/src/files/sftp.rs``),
separate from the terminal's SSH connection. Each inbound SSH connection shows up
on the container as an ESTABLISHED socket whose **local** port is 22. We count
those straight from ``/proc/net/tcp`` (port 22 = ``0016`` hex, state ``01`` =
ESTABLISHED) via ``compose exec`` — procfs only, so the probe needs no ``ps`` /
``pgrep`` / ``ss`` in the minimal Ubuntu image and does not care whether sshd uses
an external ``sftp-server`` or the built-in ``internal-sftp``.

The test then:

1. records the baseline count of ESTABLISHED SSH connections on the container;
2. connects a password SSH terminal, then opens its SFTP browser and asserts the
   SFTP session added its **own** server-side SSH connection (so we know there is
   a real session to leak);
3. quits the app (the app-quit path that runs ``SftpManager::close_all``) and
   asserts the count returns to the baseline, i.e. **no orphaned SFTP/SSH
   connection survives**.

This is a dedicated single-method suite because it quits the suite's app mid-test.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from termihub_harness import (
    ConnectionsUi,
    PasswordPromptUi,
    SSH_PASSWORD_SERVICE,
    SftpUi,
    SidebarUi,
    SshUi,
    SystemTest,
    TerminalUi,
    container_runtime,
    dev_local,
    unique_name,
)
from termihub_harness.fixtures import COMPOSE_FILE

pytestmark = pytest.mark.integration


def _count_established_ssh(service: str = SSH_PASSWORD_SERVICE) -> int:
    """Count ESTABLISHED inbound SSH connections inside ``service``'s container.

    Reads ``/proc/net/tcp`` (+ ``tcp6``) directly so the probe depends only on
    procfs — no ``ps``/``ss``/``pgrep`` needed in the minimal image. Matches rows
    whose **local** address ends in ``:0016`` (port 22) with state ``01``
    (ESTABLISHED): every inbound SSH connection (terminal *and* SFTP) is one such
    row. Raises on a failed ``compose exec`` so a broken probe fails loudly rather
    than silently reporting 0.
    """
    runtime = container_runtime()
    if runtime is None:  # pragma: no cover - guarded by the ssh_fixtures skip
        raise RuntimeError("no container runtime available for the server-side probe")
    project = dev_local.compose_project()
    # procfs-only: local port 22 == 0016, ESTABLISHED == 01. Scan tcp and tcp6 so
    # an IPv6-bound sshd is covered; a missing tcp6 is tolerated (2>/dev/null).
    script = (
        "grep -E ':0016 [0-9A-Fa-f]{8,32}:[0-9A-Fa-f]{4} 01' "
        "/proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l"
    )
    cmd = [
        runtime, "compose", "-p", project, "-f", str(COMPOSE_FILE),
        "exec", "-T", service, "sh", "-c", script,
    ]
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, **dev_local.compose_env()},
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"server-side SSH-connection probe failed (exit {result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    return int((result.stdout or "0").strip() or "0")


@pytest.mark.usefixtures("ssh_fixtures")
class TestSftpCloseAllOnQuit(
    TerminalUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    SystemTest,
):
    """App-quit closes every live SFTP session — no orphaned server-side session."""

    def test_app_quit_leaves_no_orphaned_sftp_session(self):
        # Baseline: ESTABLISHED SSH connections on the container before we connect.
        baseline = _count_established_ssh()

        # A live SSH terminal — one inbound SSH connection on the server.
        self.connect_ssh_password(unique_name("sftp-quit"))
        self.wait(
            lambda: _count_established_ssh() >= baseline + 1,
            what="the terminal's SSH connection on the server",
        )
        before_sftp = _count_established_ssh()

        # Opening the SFTP browser establishes a *dedicated* SSH connection, so the
        # server-side count must rise above the terminal-only count — proving there
        # is a real SFTP session to leak.
        self.connect_sftp_browser()
        self.wait(
            lambda: _count_established_ssh() > before_sftp,
            what="the SFTP session's own SSH connection on the server",
        )
        with_sftp = _count_established_ssh()
        assert with_sftp > before_sftp, (
            "the SFTP browser should open its own server-side SSH connection "
            f"(before={before_sftp}, with_sftp={with_sftp})"
        )

        # Quit the app — the app-quit path that runs SftpManager::close_all.
        self.app.stop()

        # No orphaned SFTP/SSH connection may survive the quit: the count returns
        # to the pre-connect baseline. wait() raises with this message on timeout.
        self.wait(
            lambda: _count_established_ssh() <= baseline,
            timeout=45.0,
            what="every SSH connection to be gone after app-quit "
            f"(baseline={baseline})",
        )
