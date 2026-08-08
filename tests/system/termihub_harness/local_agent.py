"""A harness-controlled local ``sshd`` with the ``termihub-agent`` reachable.

The desktop app reaches remote agents **only over SSH** (see the orchestrator
note / README), so a full app↔agent reconnection test needs an SSH endpoint the
harness can (a) point an agent connection at and (b) kill and restart at will to
drive a genuine transport drop. That is exactly what ``scripts/dev.sh`` sets up
for interactive dev (a throwaway loopback ``sshd`` on ``dev_agent_port`` with the
agent binary reachable); this class is the test-owned equivalent (#2476).

Key-based auth against a throwaway host + client keypair, on a free loopback
port, with ``UsePAM no`` / ``StrictModes no`` so it runs as the unprivileged test
user (mirrors ``scripts/dev.sh``). ``start`` / ``stop`` / ``restart`` own the
whole sshd process tree via ``psutil`` so a ``stop`` severs an established agent
session at once — the "server-side drop" that forces the agent reconnect path.

Skips cleanly (:class:`LocalAgentUnavailable`, turned into a ``pytest.skip`` at
the call site) when no ``sshd`` binary is present or the agent binary is not
built.
"""

from __future__ import annotations

import getpass
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import psutil

from .orchestrator import agent_binary_path, free_port


class LocalAgentUnavailable(Exception):
    """No usable ``sshd`` (or agent binary) to stand up a local agent endpoint."""


def _find_sshd() -> Optional[str]:
    for candidate in ("/usr/sbin/sshd", "/sbin/sshd"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("sshd")
    return found


class LocalAgentSshd:
    """A killable/restartable loopback ``sshd`` with the agent binary reachable.

    Usage::

        agent = LocalAgentSshd()   # raises LocalAgentUnavailable if unusable
        agent.start()
        ...                        # point a termiHub agent at agent.port (key auth)
        agent.stop()               # abrupt transport drop
        agent.start()              # transport recoverable again
        agent.cleanup()
    """

    def __init__(self, port: Optional[int] = None) -> None:
        self._sshd = _find_sshd()
        if not self._sshd:
            raise LocalAgentUnavailable("no sshd binary found (looked in /usr/sbin, /sbin, PATH)")
        try:
            self._agent_binary = agent_binary_path()
        except FileNotFoundError as exc:
            raise LocalAgentUnavailable(str(exc)) from exc

        self._username = getpass.getuser()
        self._port = port or free_port()
        self._dir = Path(tempfile.mkdtemp(prefix="termihub-agent-sshd-"))
        self._host_key = self._dir / "host_key"
        self._client_key = self._dir / "client_key"
        self._pid_file = self._dir / "sshd.pid"
        self._config = self._dir / "sshd_config"
        self._process: Optional[subprocess.Popen] = None
        self._known_hosts = Path.home() / ".ssh" / "known_hosts"
        self._known_hosts_added = False
        self._generate_keys()
        self._write_config()
        self._register_known_host()

    # ── properties the agent connection needs ────────────────────────────────────
    @property
    def port(self) -> int:
        return self._port

    @property
    def username(self) -> str:
        return self._username

    @property
    def client_key_path(self) -> str:
        return str(self._client_key)

    @property
    def agent_binary_path(self) -> str:
        return str(self._agent_binary)

    # ── lifecycle ────────────────────────────────────────────────────────────────
    def start(self, ready_timeout: float = 15.0) -> "LocalAgentSshd":
        """Launch sshd and wait until the port accepts a TCP connection."""
        if self._process is not None and self._process.poll() is None:
            raise RuntimeError("local agent sshd already running")
        # sshd daemonizes by default; -D keeps it in the foreground so we own the
        # process (and its session children) as a subprocess tree we can reap.
        self._process = subprocess.Popen(
            [self._sshd, "-D", "-f", str(self._config)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        self._wait_until_listening(ready_timeout)
        return self

    def stop(self) -> None:
        """Kill the sshd process tree (SIGKILL) — an abrupt server-side drop.

        Reaps the master *and* every session child so an established agent
        connection is severed at once, not just the listener.
        """
        if self._process is None:
            return
        proc = self._process
        self._process = None
        if proc.poll() is not None:
            return
        try:
            parent = psutil.Process(proc.pid)
            victims = parent.children(recursive=True) + [parent]
        except psutil.NoSuchProcess:
            return
        for victim in victims:
            try:
                victim.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        psutil.wait_procs(victims, timeout=5.0)

    def restart(self, ready_timeout: float = 15.0) -> None:
        self.stop()
        self.start(ready_timeout)

    def is_listening(self) -> bool:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            return sock.connect_ex(("127.0.0.1", self._port)) == 0

    def cleanup(self) -> None:
        self.stop()
        self._unregister_known_host()
        shutil.rmtree(self._dir, ignore_errors=True)

    def __enter__(self) -> "LocalAgentSshd":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()

    # ── internals ────────────────────────────────────────────────────────────────
    def _generate_keys(self) -> None:
        for path in (self._host_key, self._client_key):
            subprocess.run(
                ["ssh-keygen", "-t", "ed25519", "-f", str(path), "-N", "", "-q"],
                check=True,
                capture_output=True,
            )
        os.chmod(self._host_key, 0o600)
        os.chmod(self._client_key, 0o600)
        os.chmod(self._dir, 0o700)

    @property
    def _known_hosts_marker(self) -> str:
        """The host token our known_hosts entry is keyed on (loopback + our port)."""
        return f"[127.0.0.1]:{self._port}"

    def _register_known_host(self) -> None:
        """Pre-trust our host key in ``~/.ssh/known_hosts`` (strict verifier, #1969).

        The app's default SSH host-key verifier is strict known_hosts-only, so a
        throwaway sshd on an unknown host would otherwise block the agent connect
        on a trust prompt. Seed our ``[127.0.0.1]:<port>`` entry so the connect
        proceeds; :meth:`_unregister_known_host` removes exactly that line on
        cleanup, leaving the user's file otherwise untouched.
        """
        pub = (self._host_key.with_suffix(".pub")).read_text().split()
        # pub is: "<algo> <base64> [comment]"; build "[127.0.0.1]:<port> <algo> <base64>".
        line = f"{self._known_hosts_marker} {pub[0]} {pub[1]}\n"
        self._known_hosts.parent.mkdir(mode=0o700, exist_ok=True)
        with open(self._known_hosts, "a", encoding="utf-8") as fh:
            fh.write(line)
        self._known_hosts_added = True

    def _unregister_known_host(self) -> None:
        if not self._known_hosts_added or not self._known_hosts.exists():
            return
        try:
            kept = [
                ln
                for ln in self._known_hosts.read_text(encoding="utf-8").splitlines(keepends=True)
                if self._known_hosts_marker not in ln
            ]
            self._known_hosts.write_text("".join(kept), encoding="utf-8")
        except OSError:
            pass
        self._known_hosts_added = False

    def _write_config(self) -> None:
        # Mirrors scripts/dev.sh: loopback-only, key auth only, no PAM/strict-modes
        # so it runs unprivileged.
        self._config.write_text(
            "\n".join(
                [
                    f"Port {self._port}",
                    "ListenAddress 127.0.0.1",
                    f"HostKey {self._host_key}",
                    f"AuthorizedKeysFile {self._client_key}.pub",
                    f"PidFile {self._pid_file}",
                    "UsePAM no",
                    "PasswordAuthentication no",
                    "PubkeyAuthentication yes",
                    "StrictModes no",
                    "LogLevel ERROR",
                    "",
                ]
            )
        )

    def _wait_until_listening(self, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._process is not None and self._process.poll() is not None:
                err = ""
                if self._process.stderr is not None:
                    err = self._process.stderr.read() or ""
                raise LocalAgentUnavailable(
                    f"sshd exited early (code {self._process.returncode}): {err.strip()}"
                )
            if self.is_listening():
                return
            time.sleep(0.1)
        raise LocalAgentUnavailable(f"sshd did not listen on 127.0.0.1:{self._port} within {timeout}s")
