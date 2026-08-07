"""App-quit leaves no orphaned server-side SSH/SFTP connection — session path (#2430).

Re-establishes the invariant the retired ``test_sftp_close_all_on_quit.py`` covered
(audit gap L2 in ``docs/audits/sftp-file-browser-state-machine.md``): after termiHub
quits, **no orphaned server-side SSH/SFTP connection survives**. That test drove the
standalone UUID ``SftpManager`` and asserted its ``close_all`` app-quit path; both
were removed in #2314. SSH file browsing now resolves its core
[``SftpFileBrowser``] from the ``ConnectionType`` / session path, and a session's
connections are torn down with their owning session by **``SessionManager``** rather
than by a standalone SFTP registry (see the app-quit teardown note in
``src-tauri/src/lib.rs`` and ``src-tauri/src/session/manager.rs`` / ``file_ops.rs``).
This test re-proves the same server-side no-leak invariant on that session path.

Why the invariant still holds on the session path
--------------------------------------------------
The session-path SFTP browser is the core ``SftpFileBrowser``
(``core/src/backends/ssh/file_browser.rs``), which opens its **own dedicated** SSH
session for SFTP — lazily on first use, separate from the terminal's SSH connection —
and holds it inside the session's ``ConnectionType`` **in the app process** (not a
separate daemon/agent process). So when the app quits, the OS closes every socket the
app owned: both the terminal's SSH connection and the SFTP browser's dedicated one.
The server then observes both connections go away, and the ESTABLISHED-connection
count returns to baseline. The regression this guards against is a future change that
moves the session's SFTP connection into a process that survives app-quit.

How the server side is observed
-------------------------------
Each inbound SSH connection shows up on the container as an ESTABLISHED socket whose
**local** port is 22. We count those straight from ``/proc/net/tcp`` (port 22 =
``0016`` hex, state ``01`` = ESTABLISHED) via ``compose exec`` — procfs only, so the
probe needs no ``ps`` / ``pgrep`` / ``ss`` in the minimal Ubuntu image and does not
care whether sshd uses an external ``sftp-server`` or the built-in ``internal-sftp``.
This is the same probe the retired test used (see its git history).

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
class TestSessionSftpNoOrphanOnQuit(
    TerminalUi,
    SidebarUi,
    ConnectionsUi,
    PasswordPromptUi,
    SshUi,
    SftpUi,
    SystemTest,
):
    """App-quit closes every live session-path SFTP connection — no server-side orphan."""

    def test_app_quit_leaves_no_orphaned_session_sftp_connection(self):
        # Baseline: ESTABLISHED SSH connections on the container before we connect.
        baseline = _count_established_ssh()

        # A live SSH terminal — one inbound SSH connection on the server.
        self.connect_ssh_password(unique_name("session-sftp-quit"))
        self.wait(
            lambda: _count_established_ssh() >= baseline + 1,
            what="the terminal's SSH connection on the server",
        )
        before_sftp = _count_established_ssh()

        # Opening the session-path SFTP browser establishes the core
        # SftpFileBrowser's *dedicated* SSH connection, so the server-side count
        # must rise above the terminal-only count — proving there is a real
        # session-path SFTP connection to leak.
        self.connect_sftp_browser()
        self.wait(
            lambda: _count_established_ssh() > before_sftp,
            what="the session SFTP browser's own SSH connection on the server",
        )
        with_sftp = _count_established_ssh()
        assert with_sftp > before_sftp, (
            "the session-path SFTP browser should open its own server-side SSH "
            f"connection (before={before_sftp}, with_sftp={with_sftp})"
        )

        # Quit the app. The session (and its dedicated SFTP SSH connection) is torn
        # down with its owning SessionManager as the app process goes away.
        self.app.stop()

        # No orphaned SFTP/SSH connection may survive the quit: the count returns
        # to the pre-connect baseline. wait() raises with this message on timeout.
        self.wait(
            lambda: _count_established_ssh() <= baseline,
            timeout=45.0,
            what="every SSH connection to be gone after app-quit "
            f"(baseline={baseline})",
        )
