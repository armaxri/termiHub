"""A small unprivileged telnet server the product run starts itself (#5536).

The Docker ``telnet-server`` fixture needs a container runtime, and the system
``telnetd`` needs root. This one runs as the current user on a loopback port in
the run directory, so the telnet phase works on any macOS/Linux machine:

* Telnet option negotiation the way a real server does it: ``WILL ECHO`` and
  ``WILL SUPPRESS-GO-AHEAD`` (character mode), ``DO NAWS`` (window size) and
  ``DO TERMINAL-TYPE`` followed by ``SB TERMINAL-TYPE SEND``. What the client
  answered is recorded per session (:class:`TelnetSession`), so a step can grade
  the negotiation itself, not only the visible output.
* A ``login:`` / ``Password:`` exchange against one fixed account (the password
  is a test constant, never a real secret). The username is echoed, the
  password is not. A wrong password prints ``Login incorrect`` and asks again.
* After login, a real POSIX shell on a pseudo-terminal whose size follows the
  client's NAWS reports and whose ``TERM`` is the type the client sent. The
  shell gets the run's scratch ``HOME``, no history file and no rc files.

:meth:`TelnetServer.drop_all` closes every client socket from the server side
(the "server went away" case). Only processes this object spawned are ever
signalled.

The IAC parser (:class:`IacFilter`) is pure and unit-tested in the normal lane
(``tests/test_product_run_phase3_machinery.py``), which also runs a real
login against the server over a socket.
"""

from __future__ import annotations

import errno
import os
import select
import signal
import socket
import struct
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
OPT_ECHO, OPT_SGA, OPT_TTYPE, OPT_NAWS = 1, 3, 24, 31
TTYPE_IS, TTYPE_SEND = 0, 1

BANNER = "termiHub product-run telnet server"
PROMPT = "telnet-pr$ "


class TelnetUnavailable(RuntimeError):
    """The telnet server cannot run here (the reason is the message)."""


class IacFilter:
    """Split a client byte stream into data and telnet commands.

    :meth:`feed` returns the plain data bytes; commands go to ``on_command``
    (``(verb, option)``) and subnegotiations to ``on_subneg`` (``payload``,
    starting with the option byte). ``IAC IAC`` is a literal 255. State carries
    across calls, so a command split over two reads still parses.
    """

    def __init__(
        self,
        on_command: Callable[[int, int], None],
        on_subneg: Callable[[bytes], None],
    ) -> None:
        self._on_command = on_command
        self._on_subneg = on_subneg
        self._state = "data"
        self._verb = 0
        self._sb = bytearray()

    def feed(self, chunk: bytes) -> bytes:
        out = bytearray()
        for byte in chunk:
            state = self._state
            if state == "data":
                if byte == IAC:
                    self._state = "iac"
                else:
                    out.append(byte)
            elif state == "iac":
                if byte == IAC:
                    out.append(IAC)
                    self._state = "data"
                elif byte in (DO, DONT, WILL, WONT):
                    self._verb = byte
                    self._state = "option"
                elif byte == SB:
                    self._sb.clear()
                    self._state = "sb"
                else:  # NOP, GA, AYT, ...: a two-byte command
                    self._state = "data"
            elif state == "option":
                self._on_command(self._verb, byte)
                self._state = "data"
            elif state == "sb":
                if byte == IAC:
                    self._state = "sb_iac"
                else:
                    self._sb.append(byte)
            elif state == "sb_iac":
                if byte == SE:
                    self._on_subneg(bytes(self._sb))
                    self._state = "data"
                else:  # IAC IAC inside a subnegotiation is a literal 255
                    self._sb.append(byte)
                    self._state = "sb"
        return bytes(out)


def parse_naws(payload: bytes) -> Optional[tuple[int, int]]:
    """``(cols, rows)`` of an ``SB NAWS`` payload (option byte first), or ``None``."""
    if len(payload) != 5 or payload[0] != OPT_NAWS:
        return None
    cols, rows = struct.unpack(">HH", payload[1:5])
    return cols, rows


def parse_ttype(payload: bytes) -> Optional[str]:
    """The terminal type of an ``SB TERMINAL-TYPE IS`` payload, or ``None``."""
    if len(payload) < 2 or payload[0] != OPT_TTYPE or payload[1] != TTYPE_IS:
        return None
    return payload[2:].decode("ascii", "replace")


@dataclass
class TelnetSession:
    """What one client connection negotiated and did (read by the steps)."""

    peer: str
    commands: list[tuple[int, int]] = field(default_factory=list)
    naws: list[tuple[int, int]] = field(default_factory=list)
    ttype: Optional[str] = None
    logins: list[tuple[str, bool]] = field(default_factory=list)
    shell_pid: Optional[int] = None
    closed: bool = False

    @property
    def logged_in(self) -> bool:
        return any(ok for _, ok in self.logins)

    def client_will(self, option: int) -> bool:
        return (WILL, option) in self.commands


class TelnetServer:
    """The run's telnet server; see the module docstring."""

    def __init__(self, home: Path, *, username: str, password: str) -> None:
        if sys.platform == "win32":
            raise TelnetUnavailable("the run's telnet server needs a POSIX pseudo-terminal")
        self.home = home
        self.username = username
        self.password = password
        self.sessions: list[TelnetSession] = []
        self._listener: Optional[socket.socket] = None
        self._clients: list[socket.socket] = []
        self._pids: set[int] = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.port = 0

    # ── lifecycle ────────────────────────────────────────────────────────────
    def start(self) -> int:
        self.home.mkdir(parents=True, exist_ok=True)
        try:
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen(8)
        except OSError as exc:
            raise TelnetUnavailable(f"cannot listen on 127.0.0.1: {exc}") from exc
        self._listener = listener
        self.port = listener.getsockname()[1]
        threading.Thread(target=self._accept_loop, name="pr-telnet-accept", daemon=True).start()
        return self.port

    def stop(self) -> None:
        self._stop.set()
        if self._listener is not None:
            try:
                self._listener.close()
            except OSError:
                pass
            self._listener = None
        self.drop_all()

    def __enter__(self) -> "TelnetServer":
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.stop()

    def drop_all(self) -> int:
        """Close every client connection from the server side; return how many."""
        with self._lock:
            clients, self._clients = self._clients, []
            pids = set(self._pids)
        for sock in clients:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        for pid in pids:
            self._reap(pid)
        return len(clients)

    def latest(self) -> Optional[TelnetSession]:
        with self._lock:
            return self.sessions[-1] if self.sessions else None

    # ── internals ────────────────────────────────────────────────────────────
    def _accept_loop(self) -> None:
        while not self._stop.is_set():
            listener = self._listener
            if listener is None:
                return
            try:
                ready, _, _ = select.select([listener], [], [], 0.2)
                if not ready:
                    continue
                client, addr = listener.accept()
            except (OSError, ValueError):
                return
            session = TelnetSession(peer=f"{addr[0]}:{addr[1]}")
            with self._lock:
                self.sessions.append(session)
                self._clients.append(client)
            threading.Thread(
                target=self._serve, args=(client, session), name="pr-telnet-session", daemon=True
            ).start()

    def _reap(self, pid: int) -> None:
        for sig in (signal.SIGHUP, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass
        with self._lock:
            self._pids.discard(pid)

    def _serve(self, client: socket.socket, session: TelnetSession) -> None:
        master: Optional[int] = None
        winsize: list[tuple[int, int]] = []

        def on_command(verb: int, option: int) -> None:
            session.commands.append((verb, option))
            if verb == WILL and option == OPT_TTYPE:
                _send(bytes([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]))

        def on_subneg(payload: bytes) -> None:
            size = parse_naws(payload)
            if size is not None:
                session.naws.append(size)
                winsize.append(size)
                if master is not None:
                    _set_winsize(master, size)
                return
            ttype = parse_ttype(payload)
            if ttype is not None:
                session.ttype = ttype

        def _send(data: bytes) -> None:
            client.sendall(data)

        iac = IacFilter(on_command, on_subneg)
        try:
            _send(bytes([IAC, WILL, OPT_ECHO, IAC, WILL, OPT_SGA, IAC, DO, OPT_NAWS, IAC, DO, OPT_TTYPE]))
            reader = _LineReader(client, iac)
            _send(f"{BANNER}\r\n".encode())
            user = None
            for _attempt in range(3):
                _send(b"login: ")
                user = reader.line(echo=_send)
                _send(b"Password: ")
                password = reader.line(echo=None)
                _send(b"\r\n")
                ok = user == self.username and password == self.password
                session.logins.append((user, ok))
                if ok:
                    break
                _send(b"Login incorrect\r\n")
            if not session.logged_in:
                return
            master, pid = self._spawn_shell(session.ttype or "dumb", winsize[-1] if winsize else None)
            session.shell_pid = pid
            if reader.pending:
                os.write(master, reader.pending)
            _bridge(client, master, iac)
        except (OSError, ConnectionError, _Closed):
            pass
        finally:
            session.closed = True
            if master is not None:
                try:
                    os.close(master)
                except OSError:
                    pass
            if session.shell_pid is not None:
                self._reap(session.shell_pid)
            try:
                client.close()
            except OSError:
                pass

    def _spawn_shell(self, term: str, size: Optional[tuple[int, int]]) -> tuple[int, int]:
        import pty

        env = {
            "HOME": str(self.home),
            "USER": self.username,
            "LOGNAME": self.username,
            "TERM": term,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "PS1": PROMPT,
            "HISTFILE": "/dev/null",
            "LANG": "C",
        }
        pid, master = pty.fork()
        if pid == 0:  # child
            try:
                os.chdir(str(self.home))
                os.execve("/bin/sh", ["sh", "-i"], env)
            finally:
                os._exit(127)
        with self._lock:
            self._pids.add(pid)
        if size is not None:
            _set_winsize(master, size)
        return master, pid


class _Closed(Exception):
    pass


class _LineReader:
    """Read CR-terminated lines through the IAC filter (character-mode login)."""

    def __init__(self, client: socket.socket, iac: IacFilter) -> None:
        self._client = client
        self._iac = iac
        self.pending = b""

    def line(self, *, echo: Optional[Callable[[bytes], None]]) -> str:
        buf = bytearray()
        while True:
            if not self.pending:
                chunk = self._client.recv(1024)
                if not chunk:
                    raise _Closed()
                self.pending = self._iac.feed(chunk)
                continue
            data, self.pending = self.pending, b""
            for index, byte in enumerate(data):
                if byte in (13, 10):
                    rest = data[index + 1 :]
                    # CR LF / CR NUL end one line (RFC 854)
                    if rest[:1] in (b"\n", b"\x00"):
                        rest = rest[1:]
                    self.pending = rest
                    if echo is not None:
                        echo(b"\r\n")
                    return buf.decode("utf-8", "replace")
                if byte in (8, 127):
                    if buf:
                        buf.pop()
                        if echo is not None:
                            echo(b"\b \b")
                    continue
                buf.append(byte)
                if echo is not None:
                    echo(bytes([byte]))


def _set_winsize(fd: int, size: tuple[int, int]) -> None:
    import fcntl
    import termios

    cols, rows = size
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def _bridge(client: socket.socket, master: int, iac: IacFilter) -> None:
    """Copy client data to the shell and shell output to the client until either ends."""
    while True:
        try:
            ready, _, _ = select.select([client, master], [], [], 0.5)
        except (OSError, ValueError):
            return
        if client in ready:
            chunk = client.recv(4096)
            if not chunk:
                return
            data = iac.feed(chunk).replace(b"\r\n", b"\r").replace(b"\r\x00", b"\r")
            if data:
                os.write(master, data)
        if master in ready:
            try:
                out = os.read(master, 4096)
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EBADF):
                    return
                raise
            if not out:
                return
            client.sendall(out.replace(bytes([IAC]), bytes([IAC, IAC])))
