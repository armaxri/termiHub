"""Unit tests for the no-reverse-DNS local HTTP server helper (#3665)."""

from __future__ import annotations

import socket
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler

import pytest

from termihub_harness import LocalThreadingHTTPServer


class _OkHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (stdlib naming)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args):
        pass


def _forbid_getfqdn(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*_args, **_kwargs):
        raise AssertionError("socket.getfqdn must not be called (slow reverse DNS, #3665)")

    monkeypatch.setattr(socket, "getfqdn", _boom)


def test_construction_does_not_call_getfqdn(monkeypatch: pytest.MonkeyPatch) -> None:
    _forbid_getfqdn(monkeypatch)
    server = LocalThreadingHTTPServer(("127.0.0.1", 0), _OkHandler)
    try:
        host, port = server.server_address[:2]
        assert server.server_name == host == "127.0.0.1"
        assert server.server_port == port
        assert port > 0
    finally:
        server.server_close()


def test_serves_requests_without_getfqdn(monkeypatch: pytest.MonkeyPatch) -> None:
    _forbid_getfqdn(monkeypatch)
    server = LocalThreadingHTTPServer(("127.0.0.1", 0), _OkHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_address[1]}/"
        with urllib.request.urlopen(url, timeout=5) as resp:
            assert resp.status == 200
            assert resp.read() == b"ok"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
