"""Portable-mode staging for the orchestrator (#3691, MT-PORT-01/02).

The harness normally launches the built app with ``TERMIHUB_CONFIG_DIR`` set.
That variable overrides portable mode, so a normal launch can never prove that
portable mode works. A *portable* launch instead:

1. copies the built app into a fresh temp **portable root**: on macOS the whole
   ``termiHub.app`` bundle (the marker sits next to the bundle), elsewhere the
   bare executable;
2. adds the portable trigger next to it: an empty ``portable.marker`` file
   (:data:`MARKER`) or a ``data/`` directory (:data:`DATA_DIR`);
3. launches it **without** ``TERMIHUB_CONFIG_DIR``, so the app itself must find
   ``<root>/data/``.

To check that "nothing goes to the system profile", :func:`profile_config_dir`
names the installed-mode config directory and :func:`snapshot` /
:func:`changed_paths` diff it around a run. On Linux the profile is redirected
into a throwaway ``XDG_CONFIG_HOME`` / ``XDG_DATA_HOME`` (see
:func:`profile_env`), so a broken detection rule can never touch the real
profile. On macOS and Windows the real profile directory is snapshotted instead.
Redirecting ``HOME`` on macOS would also move the WKWebView and keychain state.
Windows resolves the profile through the Known Folder API, which ignores
environment variables.

Everything here is pure path / file work, so it is unit-tested in the normal
(non-integration) lane by ``tests/test_portable_staging.py``.
"""

from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path
from typing import Mapping, Optional

#: Flavor: activate portable mode with an empty ``portable.marker`` file.
MARKER = "marker"
#: Flavor: activate portable mode with a bare ``data/`` directory.
DATA_DIR = "data"
#: Every supported flavor.
FLAVORS = (MARKER, DATA_DIR)

#: The marker file the app looks for next to the executable / ``.app`` bundle.
MARKER_FILE = "portable.marker"
#: The portable data directory name (mirrors ``utils/portable.rs``).
DATA_DIR_NAME = "data"
#: The bundle id the installed-mode config directory is named after.
APP_IDENTIFIER = "com.termihub.app"
#: The OS lock file the app keeps inside ``data/`` while it runs (#3100).
LOCK_FILE_NAME = ".termihub.lock"


def app_bundle_of(binary: Path) -> Optional[Path]:
    """The ``*.app`` bundle that contains ``binary``, or ``None``.

    A macOS bundle executable lives at ``X.app/Contents/MacOS/<name>``.
    """
    macos_dir = binary.parent
    contents = macos_dir.parent
    bundle = contents.parent
    if macos_dir.name == "MacOS" and contents.name == "Contents" and bundle.suffix == ".app":
        return bundle
    return None


def _link_or_copy(src: str, dst: str) -> str:
    """Hard-link ``src`` to ``dst`` (instant), falling back to a real copy.

    A hard link keeps ``dst`` as the process's ``current_exe`` path, which is
    all portable detection needs. Cross-device or unsupported links fall back
    to :func:`shutil.copy2`.
    """
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)
    return dst


def stage_portable_app(binary: Path, root: Path, flavor: str) -> Path:
    """Stage ``binary`` into ``root`` as a portable install; return the new binary.

    On macOS the enclosing ``.app`` bundle is copied (the trigger must sit next
    to the bundle, not inside it). Elsewhere just the executable is copied. Then
    the ``flavor`` trigger is created in ``root``.
    """
    if flavor not in FLAVORS:
        raise ValueError(f"unknown portable flavor {flavor!r}; expected one of {FLAVORS}")
    root.mkdir(parents=True, exist_ok=True)
    bundle = app_bundle_of(binary)
    if bundle is not None:
        staged_bundle = root / bundle.name
        shutil.copytree(bundle, staged_bundle, symlinks=True, copy_function=_link_or_copy)
        staged = staged_bundle / binary.relative_to(bundle)
    else:
        staged = root / binary.name
        _link_or_copy(str(binary), str(staged))
    if flavor == MARKER:
        (root / MARKER_FILE).write_bytes(b"")
    else:
        (root / DATA_DIR_NAME).mkdir(exist_ok=True)
    return staged


def data_dir(root: Path) -> Path:
    """The portable data directory the app uses for a portable ``root``."""
    return root / DATA_DIR_NAME


def profile_env(home: Path, system: Optional[str] = None) -> dict[str, str]:
    """Environment overrides that move the installed-mode profile under ``home``.

    Only applied on Linux, where ``dirs`` honors the XDG variables and WebKitGTK
    is unaffected. macOS and Windows get no overrides (see the module docs).
    """
    if (system or platform.system()) != "Linux":
        return {}
    return {
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
    }


def profile_config_dir(
    env: Mapping[str, str], system: Optional[str] = None
) -> Optional[Path]:
    """The installed-mode config directory for a launch with environment ``env``.

    Mirrors ``dirs::config_dir()`` joined with :data:`APP_IDENTIFIER`, which is
    where Tauri's ``app_config_dir()`` points. Returns ``None`` if the base
    directory cannot be determined.
    """
    system = system or platform.system()
    if system == "Darwin":
        home = env.get("HOME")
        base = Path(home) / "Library" / "Application Support" if home else None
    elif system == "Windows":
        appdata = env.get("APPDATA")
        base = Path(appdata) if appdata else None
    else:
        xdg = env.get("XDG_CONFIG_HOME")
        home = env.get("HOME")
        base = Path(xdg) if xdg else (Path(home) / ".config" if home else None)
    return base / APP_IDENTIFIER if base is not None else None


def snapshot(directory: Optional[Path]) -> dict[str, tuple[int, int]]:
    """``{relative path: (size, mtime_ns)}`` for every file under ``directory``.

    A missing directory (the common case on a fresh CI runner) snapshots empty.
    """
    if directory is None or not directory.is_dir():
        return {}
    files: dict[str, tuple[int, int]] = {}
    for path in directory.rglob("*"):
        try:
            if path.is_file():
                stat = path.stat()
                files[str(path.relative_to(directory))] = (stat.st_size, stat.st_mtime_ns)
        except OSError:
            continue
    return files


def changed_paths(
    before: Mapping[str, tuple[int, int]], after: Mapping[str, tuple[int, int]]
) -> list[str]:
    """Paths that were created or modified between two :func:`snapshot` calls."""
    return sorted(path for path, stamp in after.items() if before.get(path) != stamp)
