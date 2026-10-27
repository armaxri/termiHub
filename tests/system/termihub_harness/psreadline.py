"""A private PSReadLine history for each Windows test app (#5055).

Every PowerShell on a Windows machine saves its PSReadLine history to one file,
``%APPDATA%\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt``.
The bulk lane runs two xdist workers, so two test apps' shells wrote that file at
once, and a grade's prompt could show the other app's command as a history
prediction (``echo PERF05-40`` in a dead-key grade, run 40582427588).

PSReadLine takes its history path from the ``AppData`` known folder, not from
the ``APPDATA`` variable, so redirecting ``APPDATA`` does nothing. Instead the
harness puts a shim module named ``PSReadLine``
(``psreadline_shim/PSReadLine/PSReadLine.psm1``) first on the test app's
``PSModulePath``. PowerShell imports that shim at startup where it would import
PSReadLine; the shim imports the real PSReadLine and sets the history path from
:data:`HISTORY_ENV` and ``-PredictionSource None``.

Only the test app's environment changes. termiHub itself starts PowerShell
untouched (#5009/#5045), and nothing is written to the user's profile.

The ``PSModulePath`` order matters. PowerShell 7 inserts its own module folders
(personal, shared, ``$PSHOME\\Modules``) at the front unless they are already
listed. Listing the shim and then PowerShell 7's personal folder makes it insert
the other two right after that folder, so its order is the usual one with the
shim first. Windows PowerShell 5.1 uses the list as given. Its own personal
folder is listed too, because 5.1 adds it only when the variable is unchanged.
"""

from __future__ import annotations

import ntpath
import platform
import uuid
from pathlib import Path
from typing import Mapping, Optional

#: Folder holding the ``PSReadLine`` shim module; it goes first on ``PSModulePath``.
SHIM_DIR = Path(__file__).resolve().parent / "psreadline_shim"

#: The variable the shim reads the history file path from.
HISTORY_ENV = "TERMIHUB_TEST_PSREADLINE_HISTORY"

#: ``FOLDERID_Documents``, the known folder both PowerShells derive their
#: personal module folders from.
_FOLDERID_DOCUMENTS = "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}"


def _documents_dir() -> Optional[str]:
    """The user's Documents known folder (Windows only), or ``None``."""
    try:
        import ctypes

        class _Guid(ctypes.Structure):
            _fields_ = [
                ("data1", ctypes.c_ulong),
                ("data2", ctypes.c_ushort),
                ("data3", ctypes.c_ushort),
                ("data4", ctypes.c_ubyte * 8),
            ]

        guid = _Guid()
        ctypes.memmove(ctypes.byref(guid), uuid.UUID(_FOLDERID_DOCUMENTS).bytes_le, 16)
        path = ctypes.c_wchar_p()
        windll = getattr(ctypes, "windll")
        if windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(path)):
            return None
        try:
            return path.value
        finally:
            windll.ole32.CoTaskMemFree(path)
    except (AttributeError, OSError):
        return None


def _norm(entry: str) -> str:
    return ntpath.normcase(entry.rstrip("\\/"))


def module_path(inherited: str, documents: str) -> str:
    """The test app's ``PSModulePath``: the shim, both personal folders, then
    the inherited entries that are not already listed."""
    head = [
        str(SHIM_DIR),
        ntpath.join(documents, "PowerShell", "Modules"),
        ntpath.join(documents, "WindowsPowerShell", "Modules"),
    ]
    seen = {_norm(entry) for entry in head}
    rest = []
    for entry in inherited.split(";"):
        if entry and _norm(entry) not in seen:
            seen.add(_norm(entry))
            rest.append(entry)
    return ";".join(head + rest)


def app_env(
    scratch_dir: Path,
    base_env: Mapping[str, str],
    *,
    system: Optional[str] = None,
    documents: Optional[str] = None,
) -> dict[str, str]:
    """Variables that give one test app's PowerShells a private history.

    The history file is ``<scratch_dir>/psreadline/ConsoleHost_history.txt``,
    so it lives and dies with the app instance. Returns ``{}`` off Windows.
    """
    if (system or platform.system()) != "Windows":
        return {}
    if documents is None:
        documents = _documents_dir() or ntpath.join(
            base_env.get("USERPROFILE", str(Path.home())), "Documents"
        )
    history = scratch_dir / "psreadline" / "ConsoleHost_history.txt"
    history.parent.mkdir(parents=True, exist_ok=True)
    # Windows variable names are case-insensitive and ``os.environ`` upper-cases
    # them, so reuse the inherited key: a second spelling would be a second entry.
    key = next((k for k in base_env if k.upper() == "PSMODULEPATH"), "PSModulePath")
    return {
        key: module_path(base_env.get(key, ""), documents),
        HISTORY_ENV: str(history),
    }
