"""The server side of the app's connections to a loopback sshd (#5449).

The native sshd fixture runs on this computer, so its end of every SSH
connection is a local socket: ``netstat -an`` lists it on macOS and
Windows alike (unprivileged, unlike reading another user's process sockets).
The app's own client ports pick out *its* connections, so a parallel worker's
sessions on the same sshd never count.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from typing import Iterable, Optional

#: The states in which the server still holds a connection: up, or the
#: client is gone and sshd has not closed its end yet (an orphan).
ALIVE_STATES = frozenset({"ESTABLISHED", "CLOSE_WAIT"})

#: An address column: ``127.0.0.1:22400`` / ``[::1]:22400`` (Windows) or
#: ``127.0.0.1.22400`` / ``::1.22400`` (macOS); the port is the last field.
_ADDR_PORT = re.compile(r"[.:](\d+)$")


@dataclass(frozen=True)
class SocketRow:
    """One TCP socket of ``netstat``: local port, foreign port, state."""

    local_port: int
    foreign_port: int
    state: str


def parse_netstat(output: str) -> list[SocketRow]:
    """The TCP sockets in ``netstat -an`` output (macOS or Windows)."""
    rows: list[SocketRow] = []
    for line in output.splitlines():
        parts = line.split()
        if not parts or not parts[0].lower().startswith("tcp"):
            continue
        # Windows: TCP local foreign state; macOS: tcp4 recv send local foreign state.
        if len(parts) == 4:
            local, foreign, state = parts[1:4]
        elif len(parts) >= 6:
            local, foreign, state = parts[3:6]
        else:
            continue
        lp, fp = _ADDR_PORT.search(local), _ADDR_PORT.search(foreign)
        if lp is None or fp is None:
            continue
        rows.append(SocketRow(int(lp.group(1)), int(fp.group(1)), state.upper()))
    return rows


def server_held(rows: Iterable[SocketRow], server_port: int, client_ports: Iterable[int]) -> int:
    """How many of ``client_ports``' connections the server on ``server_port`` still holds."""
    ports = set(client_ports)
    return sum(
        1
        for row in rows
        if row.local_port == server_port and row.foreign_port in ports and row.state in ALIVE_STATES
    )


def netstat() -> list[SocketRow]:
    """The TCP sockets of this computer now."""
    out = subprocess.run(
        ["netstat", "-an"], capture_output=True, text=True, timeout=30, check=True
    ).stdout
    return parse_netstat(out)


def client_ports(pid: Optional[int], server_port: int) -> set[int]:
    """The local ports of ``pid``'s connections to ``server_port`` (empty when unknown)."""
    if pid is None:
        return set()
    try:
        import psutil

        process = psutil.Process(pid)
        lister = getattr(process, "net_connections", None) or process.connections
        conns = lister(kind="tcp")
    except Exception:  # noqa: BLE001 - a gone/denied process has no sockets
        return set()
    return {
        int(conn.laddr.port)
        for conn in conns
        if conn.raddr and int(conn.raddr.port) == server_port and conn.laddr
    }
