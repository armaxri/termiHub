"""A loopback TCP proxy that can slow its traffic down and counts the bytes (#5204).

The transfer-relaunch suite kills the app in the middle of an SFTP transfer. On a
localhost container a 24 MiB transfer finishes in well under a second, so there
is no "middle" to kill it in, and a sleep before the kill would be a guess. The
suite therefore connects to the SSH fixture **through this proxy**:

* :meth:`ThrottleProxy.set_rate` caps each direction of each connection at a
  number of bytes per second, so the transfer takes seconds and the test can
  wait for a real progress signal (the persisted checkpoint) before it kills the
  app. ``None`` lifts the cap at once, also for connections already open.
* :attr:`ThrottleProxy.upstream_bytes` / :attr:`ThrottleProxy.downstream_bytes`
  count what went client→server and server→client. The suite reads them before
  and after the relaunch to tell a resumed transfer (it sends only the rest)
  from one that restarted from zero (it sends the whole file again).

The proxy runs on harness threads, so it outlives an app kill and a relaunch:
the saved connection keeps pointing at the same port. Each accepted connection
opens a fresh connection to the target; when either side closes, both do.
"""

from __future__ import annotations

import socket
import threading
import time
from typing import Optional

__all__ = ["ThrottleProxy"]

#: Bytes read per ``recv``. Small enough that a throttled pump sleeps in short
#: steps, so lifting the cap takes effect within one step.
_CHUNK = 16 * 1024

#: Longest single sleep of a throttled pump, so a cap change applies quickly.
_SLICE = 0.05


class ThrottleProxy:
    """Forward ``127.0.0.1:<port>`` to ``target_host:target_port``.

    Use as a context manager, or call :meth:`start` and :meth:`close`.
    """

    def __init__(self, target_host: str, target_port: int, *, bind_host: str = "127.0.0.1"):
        self._target = (target_host, target_port)
        self._bind_host = bind_host
        self._listener: Optional[socket.socket] = None
        self._rate: Optional[float] = None
        self._lock = threading.Lock()
        self._up = 0
        self._down = 0
        self._closed = threading.Event()
        self._sockets: set[socket.socket] = set()
        self._accept_thread: Optional[threading.Thread] = None
        self.port: int = 0

    # -- lifecycle ---------------------------------------------------------------
    def start(self) -> "ThrottleProxy":
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((self._bind_host, 0))
        listener.listen(16)
        self._listener = listener
        self.port = listener.getsockname()[1]
        self._accept_thread = threading.Thread(
            target=self._accept_loop, name=f"throttle-proxy-{self.port}", daemon=True
        )
        self._accept_thread.start()
        return self

    def close(self) -> None:
        """Stop accepting and close every open connection."""
        self._closed.set()
        if self._listener is not None:
            try:
                self._listener.close()
            except OSError:
                pass
        with self._lock:
            sockets = list(self._sockets)
            self._sockets.clear()
        for sock in sockets:
            _close(sock)
        if self._accept_thread is not None:
            self._accept_thread.join(timeout=2.0)

    def __enter__(self) -> "ThrottleProxy":
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # -- control and counters ----------------------------------------------------
    def set_rate(self, bytes_per_second: Optional[float]) -> None:
        """Cap each direction of each connection, or lift the cap with ``None``."""
        if bytes_per_second is not None and bytes_per_second <= 0:
            raise ValueError("rate must be positive, or None for no cap")
        self._rate = bytes_per_second

    @property
    def rate(self) -> Optional[float]:
        return self._rate

    @property
    def upstream_bytes(self) -> int:
        """Bytes forwarded client→server so far, over every connection."""
        with self._lock:
            return self._up

    @property
    def downstream_bytes(self) -> int:
        """Bytes forwarded server→client so far, over every connection."""
        with self._lock:
            return self._down

    # -- internals ---------------------------------------------------------------
    def _accept_loop(self) -> None:
        listener = self._listener
        assert listener is not None
        while not self._closed.is_set():
            try:
                client, _ = listener.accept()
            except OSError:
                return
            try:
                upstream = socket.create_connection(self._target, timeout=10.0)
                upstream.settimeout(None)
            except OSError:
                _close(client)
                continue
            for sock in (client, upstream):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            with self._lock:
                self._sockets.update((client, upstream))
            for src, dst, upward in ((client, upstream, True), (upstream, client, False)):
                threading.Thread(
                    target=self._pump, args=(src, dst, upward), daemon=True
                ).start()

    def _throttle(self, sent: int) -> None:
        """Hold the pump until ``sent`` bytes fit the current cap.

        Sleeps in short slices and re-reads the cap each time, so a lifted or
        changed cap applies at once instead of after a long sleep.
        """
        started = time.monotonic()
        while not self._closed.is_set():
            rate = self._rate
            if rate is None:
                return
            remaining = sent / rate - (time.monotonic() - started)
            if remaining <= 0:
                return
            time.sleep(min(remaining, _SLICE))

    def _pump(self, src: socket.socket, dst: socket.socket, upward: bool) -> None:
        try:
            while True:
                data = src.recv(_CHUNK)
                if not data:
                    break
                dst.sendall(data)
                with self._lock:
                    if upward:
                        self._up += len(data)
                    else:
                        self._down += len(data)
                self._throttle(len(data))
        except OSError:
            pass
        finally:
            # One side closed: close both, so the peer pump ends too.
            with self._lock:
                self._sockets.discard(src)
                self._sockets.discard(dst)
            _close(src)
            _close(dst)


def _close(sock: socket.socket) -> None:
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass
