"""Local HTTP test servers that bind without a reverse-DNS lookup.

``http.server.HTTPServer.server_bind`` sets ``self.server_name`` from
``socket.getfqdn(host)``. For a loopback bind that is a reverse-DNS (PTR) lookup
of ``127.0.0.1``, which on hosted macOS CI runners stalls for ~35 s on every
construction (issue #3665) — pure setup overhead, and a timeout risk if the
resolver is ever slower still.

:class:`LocalThreadingHTTPServer` is a drop-in :class:`ThreadingHTTPServer` whose
``server_bind`` skips that lookup: ``server_name`` is the bound host literal
instead. Nothing in the test fixtures reads ``server_name`` (it only feeds CGI
environment variables), so behaviour is otherwise identical. Use it for every
in-process HTTP fixture in the harness.
"""

from __future__ import annotations

import socketserver
from http.server import ThreadingHTTPServer

__all__ = ["LocalThreadingHTTPServer"]


class LocalThreadingHTTPServer(ThreadingHTTPServer):
    """A :class:`ThreadingHTTPServer` that never calls :func:`socket.getfqdn`."""

    def server_bind(self) -> None:
        # Mirror HTTPServer.server_bind minus the getfqdn() reverse-DNS lookup.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port
