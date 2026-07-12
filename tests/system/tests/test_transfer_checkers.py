"""App-independent tests for the FTP/TFTP transfer checkers (issue #964).

These verify the ``termihub_harness.transfers`` helpers against in-process
servers, so they run in plain CI **without** the built app (no ``integration``
marker). They guard the checkers that the Embedded Services system tests
(SVC-12 / SVC-13) rely on, replacing the old host-``curl`` dependency.

* **TFTP** — exercised against ``tftpy``'s own threaded ``TftpServer``, so the
  real RRQ download path of ``tftp_download`` is covered everywhere ``tftpy`` is
  installed (it is in ``requirements.txt``).
* **FTP** — exercised against ``pyftpdlib`` when available (a test-only dep);
  the check skips cleanly if it is missing, since ``ftp_download`` itself needs
  only the always-present stdlib :mod:`ftplib`.
"""

from __future__ import annotations

import contextlib
import socket
import threading
import time
from pathlib import Path

import pytest

from termihub_harness.transfers import ftp_download, ftp_list, tftp_download

# tftpy is a required harness dep; pyftpdlib is an optional test-only convenience.
tftpy = pytest.importorskip("tftpy", reason="tftpy required for TFTP checker tests")


def _free_port() -> int:
    """Pick an unused TCP port (good enough for the UDP-based TFTP server too)."""
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def _tftp_server(root: Path):
    """Run a tftpy TFTP server in a background thread on a free UDP port."""
    port = _free_port()
    server = tftpy.TftpServer(str(root))
    thread = threading.Thread(
        target=server.listen,
        kwargs={"listenip": "127.0.0.1", "listenport": port},
        daemon=True,
    )
    thread.start()
    # Give the server a moment to bind its socket before clients connect.
    time.sleep(0.3)
    try:
        yield port
    finally:
        with contextlib.suppress(Exception):
            server.stop(now=True)


def test_tftp_download_returns_file_bytes(tmp_path: Path):
    (tmp_path / "boot.txt").write_text("termihub-tftp-transfer-ok\n", encoding="utf-8")
    with _tftp_server(tmp_path) as port:
        data = tftp_download("127.0.0.1", port, "boot.txt")
    assert data.decode("utf-8").strip() == "termihub-tftp-transfer-ok"


def test_tftp_download_strips_leading_slash(tmp_path: Path):
    """A leading ``/`` (as in ``tftp://host/boot.txt``) must still resolve."""
    (tmp_path / "boot.txt").write_text("ok", encoding="utf-8")
    with _tftp_server(tmp_path) as port:
        data = tftp_download("127.0.0.1", port, "/boot.txt")
    assert data == b"ok"


def test_tftp_download_missing_file_raises(tmp_path: Path):
    with _tftp_server(tmp_path) as port:
        with pytest.raises(Exception):  # noqa: B017,PT011 — tftpy raises TftpException
            tftp_download("127.0.0.1", port, "nope.txt", timeout=3.0)


# ── FTP checker (pyftpdlib in-process server, optional) ──────────────────────


@contextlib.contextmanager
def _ftp_server(root: Path):
    """Run a pyftpdlib FTP server (anonymous read) in a background thread.

    The server thread must shut down **deterministically**, otherwise the run
    intermittently fails with ``OSError: [Errno 9] Bad file descriptor`` — a
    thread exception pytest surfaces as ``PytestUnhandledThreadExceptionWarning``
    (see issue #1477). The race is calling :meth:`FTPServer.close_all` from the
    main thread while the server thread is still inside ``ioloop.poll`` on the
    same sockets: closing the fds out from under ``kqueue``/``epoll`` yields
    ``EBADF``.

    To avoid it we mirror pyftpdlib's own threaded test helper: the thread runs
    ``serve_forever(blocking=False)`` in a loop gated by a stop event, and it is
    the *thread itself* that calls ``close_all`` once the loop exits — so the
    poll and the socket close never overlap. The main thread only sets the event
    and :meth:`~threading.Thread.join`\\ s, guaranteeing the loop has returned
    before the context exits.
    """
    pyftpdlib = pytest.importorskip(
        "pyftpdlib", reason="pyftpdlib (test-only) not installed; ftp_download uses stdlib"
    )
    from pyftpdlib.authorizers import DummyAuthorizer
    from pyftpdlib.handlers import FTPHandler
    from pyftpdlib.servers import FTPServer

    authorizer = DummyAuthorizer()
    authorizer.add_anonymous(str(root), perm="elr")
    handler = FTPHandler
    handler.authorizer = authorizer
    port = _free_port()
    server = FTPServer(("127.0.0.1", port), handler)

    stop = threading.Event()

    def _run() -> None:
        # Single-shot polling (blocking=False) lets us re-check the stop event
        # each iteration; close_all() runs here, in the polling thread, so it can
        # never race an in-flight poll on the just-closed sockets.
        try:
            while not stop.is_set():
                server.serve_forever(timeout=0.1, blocking=False)
        finally:
            server.close_all()

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()
    time.sleep(0.3)
    try:
        yield port
    finally:
        stop.set()
        thread.join(timeout=5.0)


def test_ftp_download_returns_file_bytes(tmp_path: Path):
    (tmp_path / "hello.txt").write_text("termihub-ftp-transfer-ok\n", encoding="utf-8")
    with _ftp_server(tmp_path) as port:
        data = ftp_download("127.0.0.1", port, "hello.txt")
    assert data.decode("utf-8").strip() == "termihub-ftp-transfer-ok"


def test_ftp_list_includes_file(tmp_path: Path):
    (tmp_path / "hello.txt").write_text("x", encoding="utf-8")
    with _ftp_server(tmp_path) as port:
        names = ftp_list("127.0.0.1", port, "/")
    assert any(Path(n).name == "hello.txt" for n in names)
