"""Self-contained FTP/TFTP download checkers for embedded-services tests.

The Embedded Services suite (SVC-12 / SVC-13) verifies that the app's local FTP
and TFTP servers serve a real file. The original port shelled out to ``curl``,
but ``curl``'s TFTP — and sometimes FTP — support is *build-dependent*: some
hosts/CI images ship a ``curl`` without ``tftp://``, so the case would silently
skip instead of verifying the transfer (issue #964).

These helpers replace that host dependency with deterministic clients that run
everywhere:

* **FTP** — Python's stdlib :mod:`ftplib` (always available).
* **TFTP** — the maintained :mod:`tftpy` library for a real RRQ download.

Both return the downloaded bytes (or text), so callers assert on the content
rather than on a subprocess exit code.
"""

from __future__ import annotations

import ftplib
import io
import os
import tempfile

__all__ = [
    "ftp_download",
    "ftp_list",
    "tftp_download",
    "TftpUnavailable",
]


class TftpUnavailable(RuntimeError):
    """Raised when the :mod:`tftpy` library is not installed.

    Callers in the system suite translate this into a clean ``pytest.skip`` so a
    missing optional dependency does not masquerade as a transfer failure — but
    once ``tftpy`` is installed (it is in ``requirements.txt``) the TFTP case is
    verified deterministically, never skipped.
    """


def ftp_download(
    host: str,
    port: int,
    remote_path: str,
    *,
    user: str = "anonymous",
    passwd: str = "anonymous@",
    timeout: float = 10.0,
) -> bytes:
    """Download ``remote_path`` from an FTP server and return its bytes.

    Uses stdlib :mod:`ftplib` (anonymous login by default), so it works on every
    host regardless of how ``curl`` was built.
    """
    buf = io.BytesIO()
    ftp = ftplib.FTP(timeout=timeout)
    try:
        ftp.connect(host, port)
        ftp.login(user, passwd)
        ftp.retrbinary(f"RETR {remote_path}", buf.write)
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa: BLE001 — best-effort close
            ftp.close()
    return buf.getvalue()


def ftp_list(
    host: str,
    port: int,
    path: str = "/",
    *,
    user: str = "anonymous",
    passwd: str = "anonymous@",
    timeout: float = 10.0,
) -> list[str]:
    """Return the entry names in ``path`` on an FTP server (stdlib ``NLST``)."""
    ftp = ftplib.FTP(timeout=timeout)
    try:
        ftp.connect(host, port)
        ftp.login(user, passwd)
        return ftp.nlst(path)
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa: BLE001 — best-effort close
            ftp.close()


def tftp_download(
    host: str,
    port: int,
    remote_path: str,
    *,
    timeout: float = 10.0,
) -> bytes:
    """Download ``remote_path`` from a TFTP server (RRQ) and return its bytes.

    Uses the maintained :mod:`tftpy` client so the transfer is verified even on
    hosts whose ``curl`` lacks ``tftp://`` support. Raises :class:`TftpUnavailable`
    if ``tftpy`` is not installed.
    """
    try:
        import tftpy  # noqa: PLC0415 — optional dep, imported lazily
    except ImportError as exc:  # pragma: no cover — exercised via skip path
        raise TftpUnavailable(
            "tftpy is not installed (pip install -r requirements.txt)"
        ) from exc

    # tftpy downloads to a file path; use a temp file and read it back so the
    # API mirrors ftp_download (return the bytes).
    fd, tmp = tempfile.mkstemp(prefix="thub-tftp-")
    os.close(fd)
    try:
        client = tftpy.TftpClient(host, port)
        client.download(remote_path.lstrip("/"), tmp, timeout=timeout)
        with open(tmp, "rb") as fh:
            return fh.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:  # noqa: PERF203 — best-effort cleanup
            pass
