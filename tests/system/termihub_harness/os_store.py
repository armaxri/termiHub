"""Read the real OS credential store from the harness, in a throwaway store (#4929).

The app keeps its secrets in the OS credential store in OS-keychain mode: the
macOS Keychain, the Linux Secret Service or the Windows Credential Manager
(``src-tauri/src/credential/os_keychain.rs``). Each secret is one item with the
service ``termiHub`` and the account ``<connection-id>:<type>``; the keys that
seal a backup restore's deferred credential import use the service
``termiHub-backup-restore``. This module lets a system test check those items
directly, which used to be the guided-manual checks MT-CRED-01/02/03/18.

It never touches the user's real secrets:

==========  ===============================================================
macOS       A temporary keychain (random password, deleted afterwards)
            becomes the per-user default keychain while the suite runs, as
            ``scripts/internal/real-keychain-tests.sh`` does. The original
            default and search list are restored on close. Because the swap
            is per user, it only runs in CI or when the developer opts in
            with ``TERMIHUB_REAL_KEYCHAIN_TESTS=1``. Lookups never read a
            secret (that would raise a keychain access prompt): they read
            item attributes only.
Linux       A private D-Bus session bus with its own ``gnome-keyring-daemon``,
            whose keyring files and sockets live in a temporary directory.
            Only the app (through ``app_env``) and ``secret-tool`` talk to it.
Windows     Credential Manager has no throwaway store, so the user's own is
            used: the app writes under run-unique connection ids, secrets are
            only read for the items a test names (listing reads target names
            only), and :meth:`close` deletes every item a test registered
            with :meth:`OsCredentialStore.track`.
==========  ===============================================================

:func:`open_store` returns the platform's store, or raises
:class:`OsStoreUnavailable` with a precise reason the caller turns into a skip.
"""

from __future__ import annotations

import atexit
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

#: The service of every termiHub credential (``SERVICE_NAME`` in os_keychain.rs).
SERVICE = "termiHub"
#: The service of the backup-restore seal keys (``RESTORE_SEAL_SERVICE``).
SEAL_SERVICE = "termiHub-backup-restore"

#: Opt-in switch for the per-user macOS keychain swap outside CI (the same one
#: the Rust real-keychain tests use).
OPT_IN_ENV = "TERMIHUB_REAL_KEYCHAIN_TESTS"

_TRUTHY = ("1", "true", "yes", "on")
_TOOL_TIMEOUT = 30.0


class OsStoreUnavailable(RuntimeError):
    """The OS credential store cannot be used here; the message says why."""


def credential_account(connection_id: str, credential_type: str = "password") -> str:
    """The account of a connection's credential (``CredentialKey``'s ``Display``)."""
    return f"{connection_id}:{credential_type}"


def windows_target(service: str, account: str) -> str:
    """The Credential Manager target name the ``keyring`` crate uses."""
    return f"{account}.{service}"


def _run(
    args: list[str],
    *,
    env: Optional[dict[str, str]] = None,
    stdin: Optional[str] = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        args,
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
        timeout=_TOOL_TIMEOUT,
    )
    if check and proc.returncode != 0:
        raise OsStoreUnavailable(
            f"`{' '.join(args)}` failed ({proc.returncode}): "
            f"{(proc.stderr or proc.stdout).strip()}"
        )
    return proc


class OsCredentialStore:
    """One platform's credential store, as a system test sees it."""

    #: Short name for messages, e.g. ``"macOS Keychain"``.
    name = "OS credential store"
    #: Whether :meth:`value` can read a secret without an OS prompt.
    reads_values = True

    def __init__(self) -> None:
        self._tracked: set[tuple[str, str]] = set()

    def app_env(self) -> dict[str, str]:
        """Environment overrides that point the app at this store."""
        return {}

    def accounts(self, service: str = SERVICE) -> set[str]:
        """Every account stored under ``service`` (in this store)."""
        raise NotImplementedError

    def exists(self, account: str, service: str = SERVICE) -> bool:
        """Whether an item for ``service`` / ``account`` exists."""
        return account in self.accounts(service)

    def value(self, account: str, service: str = SERVICE) -> Optional[str]:
        """The secret of ``service`` / ``account``, or ``None`` when absent."""
        raise NotImplementedError

    def track(self, account: str, service: str = SERVICE) -> None:
        """Remember an item a test made the app write, so :meth:`close` removes it."""
        self._tracked.add((service, account))

    def delete(self, account: str, service: str = SERVICE) -> None:
        """Remove one item if it exists."""
        raise NotImplementedError

    def close(self) -> None:
        """Remove what the test left behind and tear the throwaway store down."""
        for service, account in sorted(self._tracked):
            try:
                self.delete(account, service)
            except Exception as exc:  # noqa: BLE001 - teardown must go on
                print(f"[os_store] could not delete {service}/{account}: {exc}")
        self._tracked.clear()


# ── macOS ──────────────────────────────────────────────────────────────────
def _unquote(line: str) -> str:
    return line.strip().strip('"')


def parse_keychain_dump(text: str) -> list[dict[str, str]]:
    """Parse ``security dump-keychain`` (no ``-d``) into generic-password items.

    Each item block starts with ``keychain: ...`` and lists attributes such as
    ``"svce"<blob>="termiHub"`` and ``"acct"<blob>="id:password"``. Only
    ``genp`` (generic password) items are returned, as ``{svce, acct}``.
    """
    items: list[dict[str, str]] = []
    current: Optional[dict[str, str]] = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("keychain:"):
            current = {}
            items.append(current)
            continue
        if current is None:
            continue
        if line.startswith("class:"):
            current["class"] = _unquote(line.split(":", 1)[1])
            continue
        for attr in ("svce", "acct"):
            prefix = f'"{attr}"<blob>='
            if line.startswith(prefix):
                rest = line[len(prefix) :]
                current[attr] = "" if rest == "<NULL>" else rest.strip('"')
    return [
        {"svce": i.get("svce", ""), "acct": i.get("acct", "")}
        for i in items
        if i.get("class") == "genp"
    ]


class MacKeychainStore(OsCredentialStore):
    """A temporary keychain made the per-user default for the suite's lifetime."""

    name = "macOS Keychain (throwaway keychain)"
    #: Reading a secret the app wrote makes macOS ask whether ``security`` may
    #: use it (a GUI prompt a headless run cannot answer), so only attributes
    #: are read.
    reads_values = False

    def __init__(self) -> None:
        super().__init__()
        if shutil.which("security") is None:
            raise OsStoreUnavailable("the macOS `security` tool is not on PATH")
        self._dir = Path(tempfile.mkdtemp(prefix="termihub-os-store-"))
        self.keychain = self._dir / "termihub-system-test.keychain-db"
        self._orig_default = _unquote(
            _run(["security", "default-keychain", "-d", "user"]).stdout
        )
        self._orig_list = [
            _unquote(line)
            for line in _run(["security", "list-keychains", "-d", "user"]).stdout.splitlines()
            if line.strip()
        ]
        self._swapped = False
        atexit.register(self.close)
        password = f"termihub-{secrets.token_hex(16)}"
        try:
            _run(["security", "create-keychain", "-p", password, str(self.keychain)])
            # No auto-lock timeout, so the keychain stays unlocked for the run.
            _run(["security", "set-keychain-settings", str(self.keychain)])
            _run(["security", "unlock-keychain", "-p", password, str(self.keychain)])
            self._swapped = True
            _run(
                ["security", "list-keychains", "-d", "user", "-s", str(self.keychain)]
                + self._orig_list
            )
            _run(["security", "default-keychain", "-d", "user", "-s", str(self.keychain)])
        except BaseException:
            self.close()
            raise
        print(f"[os_store] using the throwaway keychain {self.keychain}")

    def accounts(self, service: str = SERVICE) -> set[str]:
        dump = _run(["security", "dump-keychain", str(self.keychain)]).stdout
        return {i["acct"] for i in parse_keychain_dump(dump) if i["svce"] == service}

    def exists(self, account: str, service: str = SERVICE) -> bool:
        # No -g / -w: attributes only, so no access prompt.
        proc = _run(
            ["security", "find-generic-password", "-s", service, "-a", account, str(self.keychain)],
            check=False,
        )
        return proc.returncode == 0

    def value(self, account: str, service: str = SERVICE) -> Optional[str]:
        raise NotImplementedError("reading a keychain secret raises an access prompt")

    def delete(self, account: str, service: str = SERVICE) -> None:
        _run(
            ["security", "delete-generic-password", "-s", service, "-a", account, str(self.keychain)],
            check=False,
        )

    def close(self) -> None:
        # The keychain itself is deleted below, so tracked items need no delete.
        self._tracked.clear()
        if self._swapped:
            self._swapped = False
            if self._orig_default:
                _run(
                    ["security", "default-keychain", "-d", "user", "-s", self._orig_default],
                    check=False,
                )
            if self._orig_list:
                _run(["security", "list-keychains", "-d", "user", "-s", *self._orig_list], check=False)
            restored = _unquote(
                _run(["security", "default-keychain", "-d", "user"], check=False).stdout
            )
            print(f"[os_store] restored the default keychain: {restored}")
        if self.keychain.exists():
            _run(["security", "delete-keychain", str(self.keychain)], check=False)
        shutil.rmtree(self._dir, ignore_errors=True)


# ── Linux ──────────────────────────────────────────────────────────────────
def parse_secret_tool_search(text: str) -> list[dict[str, str]]:
    """Parse ``secret-tool search --all`` output into one attribute dict per item."""
    items: list[dict[str, str]] = []
    current: Optional[dict[str, str]] = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            current = {}
            items.append(current)
            continue
        if current is None or " = " not in line:
            continue
        key, value = line.split(" = ", 1)
        if key.startswith("attribute."):
            current[key[len("attribute.") :]] = value
    return items


class SecretServiceStore(OsCredentialStore):
    """A private session bus with its own gnome-keyring, for the app and secret-tool."""

    name = "Linux Secret Service (private gnome-keyring)"

    def __init__(self) -> None:
        super().__init__()
        missing = [
            tool
            for tool in ("dbus-daemon", "gnome-keyring-daemon", "secret-tool")
            if shutil.which(tool) is None
        ]
        if missing:
            raise OsStoreUnavailable(
                f"the Linux Secret Service check needs {', '.join(missing)} "
                "(install dbus, gnome-keyring and libsecret-tools)"
            )
        self._dir = Path(tempfile.mkdtemp(prefix="termihub-os-store-"))
        self._runtime = self._dir / "runtime"
        self._data = self._dir / "data"
        self._runtime.mkdir(mode=0o700)
        self._data.mkdir(mode=0o700)
        self._bus_pid: Optional[int] = None
        self._bus_address = ""
        atexit.register(self.close)
        try:
            self._start()
        except BaseException:
            self.close()
            raise

    def _start(self) -> None:
        bus = _run(
            ["dbus-daemon", "--session", "--fork", "--print-address=1", "--print-pid=1"],
            env=self._base_env(),
        )
        lines = [line.strip() for line in bus.stdout.splitlines() if line.strip()]
        if len(lines) < 2:
            raise OsStoreUnavailable(f"dbus-daemon printed no address/pid: {bus.stdout!r}")
        self._bus_address, self._bus_pid = lines[0], int(lines[1])
        # `--unlock` reads a password on stdin and creates the `login` keyring,
        # which becomes the `default` collection the keyring crate writes to.
        # It must not be empty (see real-keychain-tests.sh).
        _run(
            ["gnome-keyring-daemon", "--unlock", "--components=secrets"],
            env=self.tool_env(),
            stdin=f"termihub-{secrets.token_hex(16)}",
        )
        # Prove the store works end to end before the app relies on it.
        probe = f"termihub-harness-probe-{secrets.token_hex(6)}"
        deadline = time.monotonic() + 10.0
        while True:
            stored = _run(
                ["secret-tool", "store", "--label", probe, "service", probe, "username", "probe"],
                env=self.tool_env(),
                stdin="probe-secret",
                check=False,
            )
            if stored.returncode == 0 or time.monotonic() >= deadline:
                break
            time.sleep(0.2)
        if stored.returncode != 0:
            raise OsStoreUnavailable(
                f"the private gnome-keyring refused a write: {stored.stderr.strip()}"
            )
        if self.value("probe", probe) != "probe-secret":
            raise OsStoreUnavailable("the private gnome-keyring did not return the probe")
        self.delete("probe", probe)
        print(f"[os_store] using a private gnome-keyring on {self._bus_address}")

    def _base_env(self) -> dict[str, str]:
        env = dict(os.environ)
        env["XDG_RUNTIME_DIR"] = str(self._runtime)
        env["XDG_DATA_HOME"] = str(self._data)
        env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        env.pop("GNOME_KEYRING_CONTROL", None)
        return env

    def tool_env(self) -> dict[str, str]:
        """The environment ``secret-tool`` / ``gnome-keyring-daemon`` run in."""
        env = self._base_env()
        env["DBUS_SESSION_BUS_ADDRESS"] = self._bus_address
        return env

    def app_env(self) -> dict[str, str]:
        return {"DBUS_SESSION_BUS_ADDRESS": self._bus_address}

    def accounts(self, service: str = SERVICE) -> set[str]:
        proc = _run(
            ["secret-tool", "search", "--all", "service", service],
            env=self.tool_env(),
            check=False,
        )
        # secret-tool prints the item attributes on stdout and some versions
        # put parts on stderr; parse both.
        items = parse_secret_tool_search(proc.stdout + "\n" + proc.stderr)
        return {i["username"] for i in items if i.get("service") == service and "username" in i}

    def value(self, account: str, service: str = SERVICE) -> Optional[str]:
        proc = _run(
            ["secret-tool", "lookup", "service", service, "username", account],
            env=self.tool_env(),
            check=False,
        )
        return proc.stdout if proc.returncode == 0 else None

    def delete(self, account: str, service: str = SERVICE) -> None:
        _run(
            ["secret-tool", "clear", "service", service, "username", account],
            env=self.tool_env(),
            check=False,
        )

    def close(self) -> None:
        self._tracked.clear()
        try:
            import psutil

            for proc in psutil.process_iter(["name"]):
                if proc.info.get("name") != "gnome-keyring-daemon":
                    continue
                try:
                    if proc.environ().get("XDG_RUNTIME_DIR") == str(self._runtime):
                        proc.kill()
                except (psutil.Error, OSError):
                    continue
            if self._bus_pid is not None:
                try:
                    psutil.Process(self._bus_pid).kill()
                except psutil.Error:
                    pass
        finally:
            self._bus_pid = None
            shutil.rmtree(self._dir, ignore_errors=True)


# ── Windows ────────────────────────────────────────────────────────────────
class WindowsCredentialStore(OsCredentialStore):
    """The user's Credential Manager, read through ``CredReadW`` / ``CredEnumerateW``."""

    name = "Windows Credential Manager"

    def __init__(self) -> None:
        super().__init__()
        import ctypes
        from ctypes import wintypes

        class FILETIME(ctypes.Structure):
            _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]

        class CREDENTIALW(ctypes.Structure):
            _fields_ = [
                ("Flags", wintypes.DWORD),
                ("Type", wintypes.DWORD),
                ("TargetName", wintypes.LPWSTR),
                ("Comment", wintypes.LPWSTR),
                ("LastWritten", FILETIME),
                ("CredentialBlobSize", wintypes.DWORD),
                ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
                ("Persist", wintypes.DWORD),
                ("AttributeCount", wintypes.DWORD),
                ("Attributes", ctypes.c_void_p),
                ("TargetAlias", wintypes.LPWSTR),
                ("UserName", wintypes.LPWSTR),
            ]

        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        pcred = ctypes.POINTER(CREDENTIALW)
        advapi.CredReadW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.POINTER(pcred),
        ]
        advapi.CredReadW.restype = wintypes.BOOL
        advapi.CredEnumerateW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.POINTER(ctypes.POINTER(pcred)),
        ]
        advapi.CredEnumerateW.restype = wintypes.BOOL
        advapi.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
        advapi.CredDeleteW.restype = wintypes.BOOL
        advapi.CredFree.argtypes = [ctypes.c_void_p]
        advapi.CredFree.restype = None
        self._ctypes = ctypes
        self._wintypes = wintypes
        self._advapi = advapi
        self._pcred = pcred

    _CRED_TYPE_GENERIC = 1
    _ERROR_NOT_FOUND = 1168

    def accounts(self, service: str = SERVICE) -> set[str]:
        ctypes, wintypes = self._ctypes, self._wintypes
        count = wintypes.DWORD(0)
        creds = ctypes.POINTER(self._pcred)()
        suffix = f".{service}"
        # CredEnumerateW filters by target-name *prefix* only, and the app's
        # targets start with the (run-unique) account, so list every target
        # and keep the ones ending in the service. Only names are looked at;
        # no secret is decoded here.
        enumerated = self._advapi.CredEnumerateW(
            None, 0, ctypes.byref(count), ctypes.byref(creds)
        )
        if not enumerated:
            err = ctypes.get_last_error()
            if err == self._ERROR_NOT_FOUND:
                return set()
            raise OSError(err, "CredEnumerateW failed")
        try:
            found = set()
            for i in range(count.value):
                cred = creds[i].contents
                target = cred.TargetName or ""
                if cred.Type == self._CRED_TYPE_GENERIC and target.endswith(suffix):
                    found.add(target[: -len(suffix)])
            return found
        finally:
            self._advapi.CredFree(creds)

    def exists(self, account: str, service: str = SERVICE) -> bool:
        return self.value(account, service) is not None

    def value(self, account: str, service: str = SERVICE) -> Optional[str]:
        ctypes = self._ctypes
        cred = self._pcred()
        target = windows_target(service, account)
        if not self._advapi.CredReadW(target, self._CRED_TYPE_GENERIC, 0, ctypes.byref(cred)):
            err = ctypes.get_last_error()
            if err == self._ERROR_NOT_FOUND:
                return None
            raise OSError(err, f"CredReadW failed for {target}")
        try:
            size = cred.contents.CredentialBlobSize
            blob = ctypes.string_at(cred.contents.CredentialBlob, size) if size else b""
            # The keyring crate stores the password as UTF-16LE.
            return blob.decode("utf-16-le")
        finally:
            self._advapi.CredFree(cred)

    def delete(self, account: str, service: str = SERVICE) -> None:
        target = windows_target(service, account)
        if not self._advapi.CredDeleteW(target, self._CRED_TYPE_GENERIC, 0):
            err = self._ctypes.get_last_error()
            if err != self._ERROR_NOT_FOUND:
                raise OSError(err, f"CredDeleteW failed for {target}")


def macos_swap_allowed(env: Optional[dict[str, str]] = None) -> bool:
    """Whether the per-user default-keychain swap may run (CI or explicit opt-in)."""
    env = dict(os.environ) if env is None else env
    if env.get(OPT_IN_ENV, "").strip().lower() in _TRUTHY:
        return True
    return env.get("CI", "").strip().lower() in _TRUTHY or env.get("GITHUB_ACTIONS") == "true"


def open_store(platform: Optional[str] = None) -> OsCredentialStore:
    """Open the platform's throwaway (or test-scoped) credential store.

    Raises :class:`OsStoreUnavailable` with the reason it cannot be used.
    """
    platform = platform or sys.platform
    if platform == "darwin":
        if not macos_swap_allowed():
            raise OsStoreUnavailable(
                "the macOS Keychain check swaps the per-user default keychain for a "
                f"throwaway one; it runs in CI or with {OPT_IN_ENV}=1"
            )
        return MacKeychainStore()
    if platform.startswith("linux"):
        return SecretServiceStore()
    if platform == "win32":
        return WindowsCredentialStore()
    raise OsStoreUnavailable(f"no OS credential store check for platform {platform!r}")
