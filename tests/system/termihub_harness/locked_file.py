"""Make a config file impossible to replace, so a startup swap fails (#4929).

A backup restore is applied at the next start by renaming staged files over
the live ones (``src-tauri/src/backup/pending.rs``). To prove a failed swap
keeps everything unchanged, a system test locks one of those files while the
app restarts:

=========  ==============================================================
macOS      ``chflags uchg`` (the owner may set and clear it, no sudo).
Linux      ``chattr +i`` through passwordless ``sudo -n`` (setting the
           immutable flag needs ``CAP_LINUX_IMMUTABLE``), on a filesystem
           that supports it.
Windows    an open handle that shares read access only, so the file stays
           readable but cannot be deleted or renamed over.
=========  ==============================================================

The file stays readable on every platform. :func:`locked` raises
:class:`LockUnavailable` with a precise reason when the platform cannot lock.
"""

from __future__ import annotations

import contextlib
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Iterator


class LockUnavailable(RuntimeError):
    """The file cannot be locked here; the message says why."""


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, timeout=30)


def _require(proc: subprocess.CompletedProcess[str], what: str) -> None:
    if proc.returncode != 0:
        raise LockUnavailable(f"{what} failed: {(proc.stderr or proc.stdout).strip()}")


@contextlib.contextmanager
def _chflags(path: Path) -> Iterator[None]:
    _require(_run(["chflags", "uchg", str(path)]), f"chflags uchg {path}")
    try:
        yield
    finally:
        _run(["chflags", "nouchg", str(path)])


@contextlib.contextmanager
def _chattr(path: Path) -> Iterator[None]:
    if shutil.which("chattr") is None:
        raise LockUnavailable("chattr is not on PATH (install e2fsprogs)")
    if _run(["sudo", "-n", "true"]).returncode != 0:
        raise LockUnavailable("locking a file on Linux needs passwordless sudo for chattr +i")
    _require(_run(["sudo", "-n", "chattr", "+i", str(path)]), f"chattr +i {path}")
    try:
        yield
    finally:
        _run(["sudo", "-n", "chattr", "-i", str(path)])


@contextlib.contextmanager
def _held_handle(path: Path) -> Iterator[None]:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    generic_read, file_share_read, open_existing = 0x80000000, 0x1, 3
    invalid = wintypes.HANDLE(-1).value
    handle = kernel32.CreateFileW(
        str(path), generic_read, file_share_read, None, open_existing, 0, None
    )
    if handle == invalid or handle is None:
        raise LockUnavailable(f"CreateFileW({path}) failed: error {ctypes.get_last_error()}")
    try:
        yield
    finally:
        kernel32.CloseHandle(handle)


def locked(path: Path) -> contextlib.AbstractContextManager[None]:
    """A context manager that keeps ``path`` readable but not replaceable."""
    if not path.is_file():
        raise LockUnavailable(f"{path} is not a file")
    if sys.platform == "darwin":
        return _chflags(path)
    if sys.platform.startswith("linux"):
        return _chattr(path)
    if sys.platform == "win32":
        return _held_handle(path)
    raise LockUnavailable(f"no file lock for platform {sys.platform!r}")
