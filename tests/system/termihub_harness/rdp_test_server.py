"""The scripted RDP server the sidecar suite connects to on every OS (#5175).

The xrdp suite (``tests/test_rdp.py``) needs the Linux ``rdp`` container, so on
macOS and Windows the RDP sidecar never met a server. ``rdp-sidecar``'s
``rdp_test_server`` example serves the scripted RDP server of the sidecar's own
redirection tests (#5271) on a loopback port: X.224 selecting TLS, a TLS
handshake with a throwaway self-signed certificate, the MCS connect sequence and
licensing, and then — under ``--act activate`` — an activated session it holds
until the client hangs up. It needs no container, so it runs on every runner.
``scripts/internal/build-system-test-app.sh`` builds it next to the sidecar.

:class:`RdpTestServer` owns one such process. The server reports on stdout
(see the example's docs): ``listening <port>``, ``dial #<n>`` per accepted
connection and ``client-info #<n> <username>`` once a connection's Client Info
PDU arrived — which the sidecar only sends after the certificate trust gate
passed. The process exits when its stdin closes, so it cannot outlive the run.

The line parsing and process lifecycle are unit-tested in the normal lane
(``tests/test_rdp_test_server.py``) against a stand-in script.
"""

from __future__ import annotations

import platform
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence

from .fixtures import REPO_ROOT

#: The example's binary name as ``cargo build --example rdp_test_server`` builds it.
RDP_TEST_SERVER_NAME = (
    "rdp_test_server.exe" if platform.system() == "Windows" else "rdp_test_server"
)
#: The acts the server can play for every connection.
ACTS = ("activate", "hangup")


class RdpTestServerUnavailable(RuntimeError):
    """The server binary is missing, or the process did not come up."""


@dataclass(frozen=True)
class ServerEvent:
    """One parsed stdout line of the server."""

    kind: str  # "listening" | "dial" | "client-info"
    number: int  # the port for "listening", else the connection number
    username: Optional[str] = None


def parse_line(line: str) -> Optional[ServerEvent]:
    """Parse one stdout line of the server; ``None`` for anything else."""
    parts = line.strip().split(" ", 2)
    try:
        if parts[0] == "listening" and len(parts) == 2:
            return ServerEvent("listening", int(parts[1]))
        if parts[0] == "dial" and len(parts) == 2 and parts[1].startswith("#"):
            return ServerEvent("dial", int(parts[1][1:]))
        if parts[0] == "client-info" and len(parts) == 3 and parts[1].startswith("#"):
            return ServerEvent("client-info", int(parts[1][1:]), parts[2])
    except ValueError:
        return None
    return None


def find_rdp_test_server(repo_root: Path = REPO_ROOT) -> Optional[Path]:
    """The built ``rdp_test_server`` example, if any (debug, then release)."""
    for profile in ("debug", "release"):
        path = repo_root / "rdp-sidecar" / "target" / profile / "examples" / RDP_TEST_SERVER_NAME
        if path.is_file():
            return path
    return None


class RdpTestServer:
    """One running scripted RDP server process.

    Build it with :meth:`for_binary` (or pass any ``command`` that speaks the
    same stdout protocol), then :meth:`start` it; :meth:`stop` (or leaving the
    ``with`` block) closes its stdin, which ends it.
    """

    def __init__(self, command: Sequence[str]) -> None:
        self._command = list(command)
        self._process: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._events: list[ServerEvent] = []
        self._output: list[str] = []
        self._port: Optional[int] = None

    @classmethod
    def for_binary(cls, binary: Path, *, act: str = "activate") -> "RdpTestServer":
        """A server from the built example on an ephemeral loopback port."""
        if act not in ACTS:
            raise ValueError(f"unknown act {act!r}; expected one of {ACTS}")
        return cls([str(binary), "--bind", "127.0.0.1:0", "--act", act])

    @property
    def port(self) -> int:
        """The port the server listens on (after :meth:`start`)."""
        if self._port is None:
            raise RdpTestServerUnavailable("the server has not been started")
        return self._port

    def start(self, *, timeout: float = 15.0) -> int:
        """Start the process and wait for its ``listening`` line; return the port."""
        try:
            self._process = subprocess.Popen(
                self._command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except OSError as exc:
            raise RdpTestServerUnavailable(f"cannot start {self._command[0]}: {exc}") from exc
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self._lock:
                listening = [e for e in self._events if e.kind == "listening"]
            if listening:
                self._port = listening[0].number
                return self._port
            if self._process.poll() is not None:
                break
            time.sleep(0.05)
        output = self.output()
        self.stop()
        raise RdpTestServerUnavailable(
            f"the RDP test server did not report a port within {timeout:.0f}s: {output!r}"
        )

    def _read(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        for line in self._process.stdout:
            event = parse_line(line)
            with self._lock:
                self._output.append(line.rstrip("\n"))
                if event is not None:
                    self._events.append(event)

    def output(self) -> list[str]:
        """Every line the process printed so far."""
        with self._lock:
            return list(self._output)

    def dials(self) -> int:
        """How many connections the server accepted so far."""
        with self._lock:
            return sum(1 for e in self._events if e.kind == "dial")

    def client_infos(self) -> list[str]:
        """The username of every Client Info PDU the server received so far."""
        with self._lock:
            return [e.username or "" for e in self._events if e.kind == "client-info"]

    def stop(self, *, timeout: float = 10.0) -> None:
        """Close the server's stdin (it exits on EOF); kill it if it lingers."""
        process, self._process = self._process, None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=timeout)
        if self._reader is not None:
            self._reader.join(timeout=timeout)

    def __enter__(self) -> "RdpTestServer":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()
