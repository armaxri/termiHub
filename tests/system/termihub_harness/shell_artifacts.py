"""Read the OS shell-integration artifacts the app writes (#4963, MT-SHI-04/05/06).

Installing the shell integration from Settings → Shell Integration writes
per-user OS state that a file manager reads to show "Open in termiHub":

=========  ==================================================================
Windows    ``HKCU\\Software\\Classes\\{Directory,Directory\\Background,*}\\shell``
           keys (one cascading ``termiHubMenu`` submenu at three or more
           always-visible entries), each with a ``command`` default value.
macOS      ``~/Library/Services/<name>.workflow`` Automator bundles: an
           ``Info.plist`` ``NSServices`` declaration and a ``document.wflow``
           "Run Shell Script" action carrying the spawn command.
Linux      the XDG launcher (``applications/termihub-*.desktop``), Nautilus
           scripts, the KDE service menu and Thunar actions in ``uca.xml``.
=========  ==================================================================

This module reads those artifacts back so a system test can assert them, and
computes the command line each one must carry (mirroring
``spawn_command_line`` in ``src-tauri/src/spawn/registry.rs``). It never writes
OS state itself, apart from the foreign fixtures a test asks it to seed.

**Sandboxing.** Linux and macOS registration follows the profile env vars, so
the system test points them at a scratch dir (``XDG_DATA_HOME`` /
``XDG_CONFIG_HOME`` on Linux, ``HOME`` on macOS, where only the Rust ``dirs``
crate reads it; Foundation and WebKit keep the real home). Windows writes the
real HKCU, so :func:`real_hkcu_skip_reason` only allows it on a disposable CI
runner or with an explicit opt-in, and :func:`real_registration_lock` stops two
suites on one runner from clobbering each other's registration.

Pure path / parsing logic, unit-tested in the normal lane by
``tests/test_shell_artifacts.py``.
"""

from __future__ import annotations

import contextlib
import os
import plistlib
import platform
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Mapping, Optional

from .moved_binary import ALLOW_REAL_REGISTRATION_ENV

#: Owner markers the app stamps into its artifacts (``registry.rs``).
LINUX_DESKTOP_MARKER = "X-TermiHub-Managed=true"
NAUTILUS_MARKER = "# termiHub shell integration (managed)"
MACOS_MARKER_KEY = "TermiHubShellIntegration"

#: Windows class-store layout (``registry.rs`` ``imp``).
WINDOWS_CLASSES_ROOT = r"Software\Classes"
WINDOWS_SHELL_ROOTS = {
    "folder": r"Directory\shell",
    "background": r"Directory\Background\shell",
    "file": r"*\shell",
}
WINDOWS_PLACEHOLDERS = {"folder": "%1", "background": "%V", "file": "%1"}
WINDOWS_SUBMENU_KEY = "termiHubMenu"


# ── Expected values ──────────────────────────────────────────────────────────
def spawn_command_line(exe: str, entry_id: str, kind: Optional[str], location: str) -> str:
    """The spawn command a surface invokes, byte-for-byte as the app writes it.

    ``kind`` is the entry's remembered spawn kind; ``None`` / ``"auto"`` emits
    no ``--kind`` flag. ``location`` is the already-quoted location token.
    """
    kind_flag = f" --kind {kind}" if kind and kind != "auto" else ""
    return f'"{exe}" spawn --entry-id {entry_id}{kind_flag} --location {location}'


def id_slug(entry_id: str, separator: str, trim: bool) -> str:
    """The key / filename slug of an entry id (``registry.rs::id_slug``)."""
    mapped = "".join(
        c.lower() if c.isascii() and c.isalnum() else separator for c in entry_id
    )
    return mapped.strip(separator) if trim else mapped


def linux_slug(entry_id: str) -> str:
    return id_slug(entry_id, "-", True) or "entry"


def windows_key_name(entry_id: str) -> str:
    return "termihub_" + id_slug(entry_id, "_", False)


def entry_kind(entry: Mapping) -> Optional[str]:
    return entry.get("spawnKind")


def shows_for_dirs(entry: Mapping) -> bool:
    show = entry.get("showFor", {})
    return bool(show.get("folders") or show.get("folderBackground"))


# ── Linux ────────────────────────────────────────────────────────────────────
@dataclass
class LinuxSurfaces:
    """Every termiHub-owned Linux artifact found under one profile."""

    #: ``applications/termihub-*.desktop`` → contents.
    xdg: dict[str, str] = field(default_factory=dict)
    #: Nautilus script filename → (contents, mode bits).
    nautilus: dict[str, tuple[str, int]] = field(default_factory=dict)
    #: KDE service-menu ``.desktop`` path relative to the data dir → contents.
    kde: dict[str, str] = field(default_factory=dict)
    #: Thunar ``unique-id`` → ``{"name", "command", "directories", "other-files"}``.
    thunar: dict[str, dict] = field(default_factory=dict)

    def empty(self) -> bool:
        return not (self.xdg or self.nautilus or self.kde or self.thunar)


def linux_dirs(data_home: Path, config_home: Path) -> dict[str, Path]:
    """The surface dirs the Linux registrar uses under one profile."""
    return {
        "applications": data_home / "applications",
        "nautilus": data_home / "nautilus" / "scripts",
        "kde6": data_home / "kio" / "servicemenus",
        "kde5": data_home / "kservices5" / "ServiceMenus",
        "thunar": config_home / "Thunar",
    }


def thunar_actions(uca_xml: str) -> dict[str, dict]:
    """``unique-id`` → fields of every action in a Thunar ``uca.xml``."""
    actions: dict[str, dict] = {}
    root = ET.fromstring(uca_xml)
    for action in root.iter("action"):
        uid = (action.findtext("unique-id") or "").strip()
        actions[uid] = {
            "name": (action.findtext("name") or "").strip(),
            "command": (action.findtext("command") or "").strip(),
            "directories": action.find("directories") is not None,
            "other-files": action.find("other-files") is not None,
        }
    return actions


def read_linux_surfaces(data_home: Path, config_home: Path) -> LinuxSurfaces:
    """Collect the termiHub-owned artifacts (by owner marker / id prefix)."""
    dirs = linux_dirs(data_home, config_home)
    found = LinuxSurfaces()
    apps = dirs["applications"]
    if apps.is_dir():
        for path in sorted(apps.glob("termihub-*.desktop")):
            text = path.read_text(encoding="utf-8")
            if LINUX_DESKTOP_MARKER in text:
                found.xdg[path.name] = text
    scripts = dirs["nautilus"]
    if scripts.is_dir():
        for path in sorted(scripts.iterdir()):
            if path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace")
                if NAUTILUS_MARKER in text:
                    found.nautilus[path.name] = (text, path.stat().st_mode & 0o777)
    for key in ("kde5", "kde6"):
        menus = dirs[key]
        if menus.is_dir():
            for path in sorted(menus.glob("termihub-*.desktop")):
                text = path.read_text(encoding="utf-8")
                if LINUX_DESKTOP_MARKER in text:
                    found.kde[str(path.relative_to(data_home))] = text
    uca = dirs["thunar"] / "uca.xml"
    if uca.is_file():
        found.thunar = {
            uid: fields
            for uid, fields in thunar_actions(uca.read_text(encoding="utf-8")).items()
            if uid.startswith("termihub-")
        }
    return found


def desktop_key(text: str, key: str, section: Optional[str] = None) -> Optional[str]:
    """The value of ``key`` in a Desktop Entry file (first match in ``section``)."""
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1]
            continue
        if section is not None and current != section:
            continue
        name, sep, value = line.partition("=")
        if sep and name == key:
            return value
    return None


#: Foreign fixtures a Linux test seeds before Install; uninstall must keep them.
LINUX_FOREIGN_THUNAR_ID = "foreign-4963-action"


def seed_linux_foreign(data_home: Path, config_home: Path) -> dict[Path, bytes]:
    """Create the file-manager dirs (so all three managers are detected) plus
    foreign artifacts termiHub must never remove. Returns ``{path: bytes}``.
    """
    dirs = linux_dirs(data_home, config_home)
    for key in ("applications", "nautilus", "kde6", "thunar"):
        dirs[key].mkdir(parents=True, exist_ok=True)
    foreign = {
        # Same prefix as ours, but no owner marker: must survive.
        dirs["applications"] / "termihub-foreign.desktop": (
            "[Desktop Entry]\nType=Application\nName=Foreign\nExec=true\n"
        ),
        dirs["applications"] / "other-app.desktop": (
            "[Desktop Entry]\nType=Application\nName=Other\nExec=true\n"
        ),
        dirs["nautilus"] / "My Own Script": "#!/bin/sh\necho mine\n",
        dirs["kde6"] / "foreign-menu.desktop": (
            "[Desktop Entry]\nType=Service\nMimeType=inode/directory;\nActions=x;\n"
        ),
        dirs["thunar"] / "uca.xml": (
            '<?xml version="1.0" encoding="UTF-8"?>\n<actions>\n'
            "<!-- the user's own action -->\n"
            "<action>\n\t<icon>utilities-terminal</icon>\n\t<name>Foreign</name>\n"
            f"\t<unique-id>{LINUX_FOREIGN_THUNAR_ID}</unique-id>\n"
            "\t<command>xterm %f</command>\n\t<patterns>*</patterns>\n"
            "\t<directories/>\n</action>\n</actions>\n"
        ),
    }
    out: dict[Path, bytes] = {}
    for path, text in foreign.items():
        path.write_text(text, encoding="utf-8")
        out[path] = path.read_bytes()
    return out


# ── macOS ────────────────────────────────────────────────────────────────────
@dataclass
class MacBundle:
    """One termiHub Quick Action bundle, parsed."""

    menu_item: str
    send_file_types: list[str]
    command: str
    workflow_type: str
    message: str


def read_macos_bundles(services_dir: Path) -> dict[str, MacBundle]:
    """``<name>.workflow`` → parsed bundle, for bundles carrying the owner marker."""
    bundles: dict[str, MacBundle] = {}
    if not services_dir.is_dir():
        return bundles
    for bundle in sorted(services_dir.glob("*.workflow")):
        info_path = bundle / "Contents" / "Info.plist"
        if not info_path.is_file():
            continue
        info = plistlib.loads(info_path.read_bytes())
        if info.get(MACOS_MARKER_KEY) is not True:
            continue
        service = info["NSServices"][0]
        wflow = plistlib.loads((bundle / "Contents" / "document.wflow").read_bytes())
        action = wflow["actions"][0]["action"]
        bundles[bundle.name] = MacBundle(
            menu_item=service["NSMenuItem"]["default"],
            send_file_types=list(service["NSSendFileTypes"]),
            command=action["ActionParameters"]["COMMAND_STRING"],
            workflow_type=wflow["workflowMetaData"]["workflowTypeIdentifier"],
            message=service["NSMessage"],
        )
    return bundles


def macos_send_file_types(entry: Mapping) -> list[str]:
    """The UTIs a bundle must accept for an entry's targets."""
    show = entry.get("showFor", {})
    types = []
    if show.get("folders") or show.get("folderBackground"):
        types.append("public.folder")
    if show.get("files"):
        types.append("public.data")
    return types or ["public.item"]


def seed_macos_foreign(services_dir: Path) -> dict[Path, bytes]:
    """A foreign Quick Action (no owner marker) uninstall must keep."""
    contents = services_dir / "Foreign 4963.workflow" / "Contents"
    contents.mkdir(parents=True, exist_ok=True)
    info = contents / "Info.plist"
    info.write_bytes(
        plistlib.dumps({"NSServices": [{"NSMenuItem": {"default": "Foreign 4963"}}]})
    )
    return {info: info.read_bytes()}


# ── Windows ──────────────────────────────────────────────────────────────────
@dataclass
class WinEntry:
    """One termiHub entry key under an Explorer ``shell`` root."""

    root: str
    key: str
    display_name: str
    command: str
    icon: Optional[str]
    extended: bool
    in_submenu: bool


@dataclass
class WinSubmenu:
    root: str
    verb: Optional[str]
    sub_commands: Optional[str]
    icon: Optional[str]


def _reg_value(key, name: str) -> Optional[str]:
    import winreg  # noqa: PLC0415 - Windows-only

    try:
        return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def _subkeys(key) -> list[str]:
    import winreg  # noqa: PLC0415 - Windows-only

    names, index = [], 0
    while True:
        try:
            names.append(winreg.EnumKey(key, index))
        except OSError:
            return names
        index += 1


def read_windows_registry(
    classes_root: str = WINDOWS_CLASSES_ROOT,
) -> tuple[list[WinEntry], list[WinSubmenu]]:
    """Every termiHub entry key and submenu parent under the three roots."""
    import winreg  # noqa: PLC0415 - Windows-only

    hkcu = winreg.HKEY_CURRENT_USER
    entries: list[WinEntry] = []
    submenus: list[WinSubmenu] = []

    def read_entries(parent_path: str, root: str, in_submenu: bool) -> None:
        try:
            parent = winreg.OpenKey(hkcu, parent_path)
        except OSError:
            return
        with parent:
            for name in _subkeys(parent):
                if not name.lower().startswith("termihub"):
                    continue
                path = rf"{parent_path}\{name}"
                with winreg.OpenKey(hkcu, path) as key:
                    if name == WINDOWS_SUBMENU_KEY:
                        submenus.append(
                            WinSubmenu(
                                root=root,
                                verb=_reg_value(key, "MUIVerb"),
                                sub_commands=_reg_value(key, "SubCommands"),
                                icon=_reg_value(key, "Icon"),
                            )
                        )
                        read_entries(rf"{path}\shell", root, True)
                        continue
                    command = ""
                    try:
                        with winreg.OpenKey(hkcu, rf"{path}\command") as cmd:
                            command = _reg_value(cmd, "") or ""
                    except OSError:
                        pass
                    entries.append(
                        WinEntry(
                            root=root,
                            key=name,
                            display_name=_reg_value(key, "") or "",
                            command=command,
                            icon=_reg_value(key, "Icon"),
                            extended=_reg_value(key, "Extended") is not None,
                            in_submenu=in_submenu,
                        )
                    )

    for root, sub in WINDOWS_SHELL_ROOTS.items():
        read_entries(rf"{classes_root}\{sub}", root, False)
    return entries, submenus


#: A foreign Explorer verb a Windows test seeds; uninstall must keep it.
WINDOWS_FOREIGN_KEY = "foreign4963verb"


def seed_windows_foreign(classes_root: str = WINDOWS_CLASSES_ROOT) -> str:
    """Write a foreign ``Directory\\shell`` verb; return its registry path."""
    import winreg  # noqa: PLC0415 - Windows-only

    path = rf"{classes_root}\{WINDOWS_SHELL_ROOTS['folder']}\{WINDOWS_FOREIGN_KEY}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, path) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, "Foreign 4963")
    return path


def windows_key_exists(path: str) -> bool:
    import winreg  # noqa: PLC0415 - Windows-only

    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CURRENT_USER, path))
        return True
    except OSError:
        return False


def delete_windows_key(path: str) -> None:
    """Delete ``path`` (one level deep is all the foreign fixture has)."""
    import winreg  # noqa: PLC0415 - Windows-only

    with contextlib.suppress(OSError):
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)


# ── Real-registration guard ──────────────────────────────────────────────────
def _truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() not in ("", "0", "false", "no")


def real_hkcu_skip_reason(
    system: Optional[str] = None, env: Optional[Mapping[str, str]] = None
) -> Optional[str]:
    """Why the real-HKCU Windows registration must not run here, or ``None``.

    Linux and macOS are sandboxed, so only Windows can be refused: it needs
    ``CI`` (a disposable runner) or :data:`ALLOW_REAL_REGISTRATION_ENV`.
    Installing replaces, and uninstalling removes, every ``termihub*`` Explorer
    key, including a developer's own installed termiHub registration.
    """
    system = system or platform.system()
    env = os.environ if env is None else env
    if system != "Windows":
        return None
    if _truthy(env.get("CI")) or _truthy(env.get(ALLOW_REAL_REGISTRATION_ENV)):
        return None
    return (
        "shell-integration artifacts on Windows write the real HKCU registry; runs "
        f"on CI only (set {ALLOW_REAL_REGISTRATION_ENV}=1 to opt in)"
    )


#: Lock file serialising real per-user registration across xdist workers.
LOCK_NAME = "termihub-real-shell-registration.lock"


@contextlib.contextmanager
def real_registration_lock(
    timeout: float = 600.0, lock_dir: Optional[Path] = None
) -> Iterator[None]:
    """Hold an inter-process lock while a suite owns the real registration.

    Install clears every termiHub registration before writing its own, and
    uninstall removes them all, so two suites on one runner (xdist workers)
    must not overlap while they touch the real HKCU / ``~/Library/Services``.
    """
    path = (lock_dir or Path(tempfile.gettempdir())) / LOCK_NAME
    handle = open(path, "a+b")  # noqa: SIM115 - held for the context
    try:
        deadline = time.monotonic() + timeout
        if os.name == "nt":
            import msvcrt  # noqa: PLC0415 - Windows-only

            handle.seek(0)
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"timed out waiting for {path}") from None
                    time.sleep(0.5)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl  # noqa: PLC0415 - POSIX-only

            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        raise TimeoutError(f"timed out waiting for {path}") from None
                    time.sleep(0.5)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()
