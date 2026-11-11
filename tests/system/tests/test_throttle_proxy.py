"""App-independent tests for the throttling TCP proxy (#5204).

The transfer-relaunch suite relies on the proxy to forward bytes unchanged, to
count them per direction, and to slow a transfer down until the cap is lifted.
These run against an in-process echo server, so they need no app and no Docker.
"""

from __future__ import annotations

import os
import socket
import threading
import time

import pytest

from termihub_harness.throttle_proxy import ThrottleProxy


@pytest.fixture
def echo_server():
    """A loopback server that echoes every byte back; yields its port."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    stop = threading.Event()

    def serve(conn: socket.socket) -> None:
        with conn:
            while True:
                try:
                    data = conn.recv(65536)
                except OSError:
                    return
                if not data:
                    return
                conn.sendall(data)

    def accept() -> None:
        while not stop.is_set():
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=serve, args=(conn,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    yield listener.getsockname()[1]
    stop.set()
    listener.close()


def _round_trip(port: int, payload: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        received = bytearray()

        def reader() -> None:
            while len(received) < len(payload):
                chunk = sock.recv(65536)
                if not chunk:
                    return
                received.extend(chunk)

        thread = threading.Thread(target=reader)
        thread.start()
        sock.sendall(payload)
        thread.join(timeout=30)
        return bytes(received)


def _wait_counts(proxy: ThrottleProxy, size: int) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if proxy.upstream_bytes >= size and proxy.downstream_bytes >= size:
            return
        time.sleep(0.01)


def test_forwards_bytes_unchanged_and_counts_each_direction(echo_server):
    payload = os.urandom(300 * 1024)
    with ThrottleProxy("127.0.0.1", echo_server) as proxy:
        assert _round_trip(proxy.port, payload) == payload
        _wait_counts(proxy, len(payload))
        assert proxy.upstream_bytes == len(payload)
        assert proxy.downstream_bytes == len(payload)


def test_a_cap_slows_the_transfer_down(echo_server):
    payload = os.urandom(256 * 1024)
    with ThrottleProxy("127.0.0.1", echo_server) as proxy:
        proxy.set_rate(1024 * 1024)
        started = time.monotonic()
        assert _round_trip(proxy.port, payload) == payload
        # 256 KiB at 1 MiB/s is at least 0.25 s; only the lower bound is asserted.
        assert time.monotonic() - started >= 0.2


def test_lifting_the_cap_takes_effect_on_an_open_connection(echo_server):
    with ThrottleProxy("127.0.0.1", echo_server) as proxy:
        proxy.set_rate(1024)  # 1 KiB/s: 64 KiB would take a minute
        result: dict[str, bytes] = {}
        payload = os.urandom(64 * 1024)
        thread = threading.Thread(target=lambda: result.update(data=_round_trip(proxy.port, payload)))
        thread.start()
        time.sleep(0.3)
        proxy.set_rate(None)
        thread.join(timeout=20)
        assert not thread.is_alive(), "lifting the cap must let the transfer finish"
        assert result["data"] == payload


def test_rejects_a_non_positive_rate():
    proxy = ThrottleProxy("127.0.0.1", 9)
    with pytest.raises(ValueError):
        proxy.set_rate(0)


def test_close_drops_open_connections(echo_server):
    proxy = ThrottleProxy("127.0.0.1", echo_server).start()
    sock = socket.create_connection(("127.0.0.1", proxy.port), timeout=5)
    sock.sendall(b"x")
    assert sock.recv(1) == b"x"
    proxy.close()
    sock.settimeout(5)
    assert sock.recv(1) == b"", "the client side must see the proxy close"
    sock.close()
