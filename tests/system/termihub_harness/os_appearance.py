"""Flip the OS light/dark appearance for the System-theme grade (MT-UI-05, #4930).

termiHub's ``system`` theme follows ``prefers-color-scheme`` live. Grading that
needs the OS appearance itself to change while the app runs, which is a change
to the machine, not to the app. So this helper is deliberately fenced:

* It **only acts on a CI runner** (``GITHUB_ACTIONS=true``) — an ephemeral VM
  nobody looks at — **or when the operator opts in** with
  ``TERMIHUB_ALLOW_OS_APPEARANCE=1``. A local run without the opt-in never
  touches the maintainer's own appearance: :func:`os_appearance` raises
  :class:`AppearanceUnavailable` and the test skips with the opt-in hint.
* It **always restores** the appearance it found (a context manager with the
  restore in ``finally``).
* It never names or targets an application: it changes the OS preference and
  lets the app under test (found by the harness by PID) react.

Per platform:

``darwin``
    ``osascript`` drives System Events' ``appearance preferences``. That needs
    the Automation permission for System Events; when macOS refuses it (error
    -1743, the usual state of a hosted runner) the helper reports the platform
    as unavailable rather than guessing.
``win32``
    ``HKCU\\…\\Themes\\Personalize\\AppsUseLightTheme`` plus a
    ``WM_SETTINGCHANGE("ImmersiveColorSet")`` broadcast, the notification
    WebView2 listens to.
``linux``
    The app runs on the harness's X display (Xvfb on CI). The helper becomes
    that display's XSETTINGS manager with ``xsettingsd`` and flips
    ``Net/ThemeName`` between ``Adwaita`` and ``Adwaita-dark``; WebKitGTK maps
    a ``-dark`` GTK theme to ``prefers-color-scheme: dark`` and re-evaluates on
    the change. When the display already has an XSETTINGS manager (a desktop
    session) the helper reports unavailable instead of starting — xsettingsd
    would steal the selection — so it can only ever affect a private display.
    Restore switches back to the light theme, then stops the helper's
    ``xsettingsd``.

The gating and command construction are pure and unit-tested
(``tests/test_os_appearance.py``); the real toggle runs in
``test_theme_layout_grades.py``.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Mapping, Optional, Protocol

#: Opt-in for a local (non-CI) run to change the OS appearance (then restored).
OPT_IN_ENV = "TERMIHUB_ALLOW_OS_APPEARANCE"

_TRUTHY = ("1", "true", "yes", "on")

#: Subprocess timeout: an un-granted Automation prompt must not hang the run.
_TIMEOUT = 20.0


class AppearanceUnavailable(RuntimeError):
    """The OS appearance cannot (or may not) be changed in this environment."""


def gate_reason(env: Mapping[str, str], platform: str) -> Optional[str]:
    """Why the helper may not act here, or ``None`` when it may.

    Acts on a CI runner or with the explicit opt-in; on every other run it
    refuses, so a developer's own appearance is never changed by accident.
    """
    if platform not in ("darwin", "win32", "linux"):
        return f"no OS appearance toggle for platform {platform!r}"
    on_ci = env.get("GITHUB_ACTIONS", "").lower() == "true"
    opted_in = env.get(OPT_IN_ENV, "").strip().lower() in _TRUTHY
    if not (on_ci or opted_in):
        return (
            "changing the OS appearance is CI-only; set "
            f"{OPT_IN_ENV}=1 to let this run flip it (it is restored afterwards)"
        )
    return None


def macos_script(dark: Optional[bool]) -> list[str]:
    """``osascript`` argv that reads (``dark=None``) or sets dark mode."""
    action = "get dark mode" if dark is None else f"set dark mode to {str(dark).lower()}"
    return [
        "osascript",
        "-e",
        f'tell application "System Events" to tell appearance preferences to {action}',
    ]


def xsettings_config(dark: bool) -> str:
    """The ``xsettingsd`` config selecting the light or dark GTK theme."""
    theme = "Adwaita-dark" if dark else "Adwaita"
    prefer = 1 if dark else 0
    return f'Net/ThemeName "{theme}"\nGtk/ApplicationPreferDarkTheme {prefer}\n'


class _Backend(Protocol):
    def get(self) -> bool: ...
    def set(self, dark: bool) -> None: ...
    def close(self) -> None: ...


def _run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AppearanceUnavailable(f"{argv[0]} failed: {exc}") from exc


class _MacBackend:
    def get(self) -> bool:
        out = _run(macos_script(None))
        if out.returncode != 0:
            raise AppearanceUnavailable(
                "macOS refused System Events automation (appearance preferences): "
                f"{(out.stderr or out.stdout).strip()}"
            )
        return out.stdout.strip() == "true"

    def set(self, dark: bool) -> None:
        out = _run(macos_script(dark))
        if out.returncode != 0:
            raise AppearanceUnavailable(
                f"macOS refused to set dark mode: {(out.stderr or out.stdout).strip()}"
            )

    def close(self) -> None:
        pass


class _WindowsBackend:
    _KEY = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"

    def get(self) -> bool:
        import winreg  # type: ignore[import-not-found]

        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, self._KEY) as key:
                light, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
        except FileNotFoundError:
            return False  # unset reads as the light default -> not dark
        return not bool(light)

    def set(self, dark: bool) -> None:
        import ctypes
        import winreg  # type: ignore[import-not-found]

        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, self._KEY) as key:
            winreg.SetValueEx(key, "AppsUseLightTheme", 0, winreg.REG_DWORD, 0 if dark else 1)
        hwnd_broadcast, wm_settingchange, smto_abortifhung = 0xFFFF, 0x001A, 0x0002
        result = ctypes.c_ulong()
        ctypes.windll.user32.SendMessageTimeoutW(  # type: ignore[attr-defined]
            hwnd_broadcast,
            wm_settingchange,
            0,
            "ImmersiveColorSet",
            smto_abortifhung,
            5000,
            ctypes.byref(result),
        )

    def close(self) -> None:
        pass


#: Seconds xsettingsd gets to reload after SIGHUP (it handles the signal async).
_RELOAD_SETTLE = 0.5


def _xsettings_owner() -> int:
    """Window id owning ``_XSETTINGS_S<screen>`` on ``$DISPLAY`` (0 = none).

    Raises :class:`AppearanceUnavailable` when libX11 or the display is missing.
    """
    import ctypes
    import ctypes.util

    name = ctypes.util.find_library("X11")
    if not name:
        raise AppearanceUnavailable("libX11 not found")
    x11 = ctypes.CDLL(name)
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XGetSelectionOwner.restype = ctypes.c_ulong
    x11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(None)
    if not display:
        raise AppearanceUnavailable(f"cannot open X display {os.environ.get('DISPLAY')!r}")
    try:
        screen = x11.XDefaultScreen(display)
        atom = x11.XInternAtom(display, f"_XSETTINGS_S{screen}".encode(), 0)
        return int(x11.XGetSelectionOwner(display, atom))
    finally:
        x11.XCloseDisplay(display)


class _LinuxBackend:
    """Own the display's XSETTINGS selection with a private ``xsettingsd``."""

    def __init__(self) -> None:
        if not os.environ.get("DISPLAY"):
            raise AppearanceUnavailable("no X display (DISPLAY unset) to set XSETTINGS on")
        owner = _xsettings_owner()
        if owner != 0:
            raise AppearanceUnavailable(
                "the X display already has an XSETTINGS manager (a desktop session?); "
                "refusing to replace it"
            )
        binary = shutil.which("xsettingsd")
        if not binary:
            raise AppearanceUnavailable("xsettingsd is not installed")
        self._binary = binary
        self._dir = Path(tempfile.mkdtemp(prefix="termihub-xsettings-"))
        self._config = self._dir / "xsettingsd.conf"
        self._dark = False
        self._config.write_text(xsettings_config(False), encoding="utf-8")
        self._proc = subprocess.Popen(
            [binary, "-c", str(self._config)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.monotonic() + 10.0
        while _xsettings_owner() == 0:
            if self._proc.poll() is not None or time.monotonic() > deadline:
                self.close()
                raise AppearanceUnavailable("xsettingsd did not become the XSETTINGS manager")
            time.sleep(0.1)

    def get(self) -> bool:
        return self._dark

    def set(self, dark: bool) -> None:
        self._config.write_text(xsettings_config(dark), encoding="utf-8")
        self._proc.send_signal(signal.SIGHUP)  # xsettingsd reloads its config
        self._dark = dark
        time.sleep(_RELOAD_SETTLE)  # let it reload before a caller acts or stops it

    def close(self) -> None:
        if self._proc.poll() is None and self._dark:
            self.set(False)  # clients keep the last value when the manager leaves
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        shutil.rmtree(self._dir, ignore_errors=True)


def _backend(platform: str) -> _Backend:
    if platform == "darwin":
        return _MacBackend()
    if platform == "win32":
        return _WindowsBackend()
    return _LinuxBackend()


class OsAppearance:
    """A live handle on the OS appearance, valid inside :func:`os_appearance`."""

    def __init__(self, backend: _Backend) -> None:
        self._backend = backend

    def is_dark(self) -> bool:
        return self._backend.get()

    def set_dark(self, dark: bool) -> None:
        self._backend.set(dark)


@contextmanager
def os_appearance(
    env: Optional[Mapping[str, str]] = None, platform: Optional[str] = None
) -> Iterator[OsAppearance]:
    """Yield an :class:`OsAppearance`; restore the original appearance on exit.

    Raises :class:`AppearanceUnavailable` (before changing anything) when the
    gate refuses or the platform toggle cannot work here.
    """
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    reason = gate_reason(env, platform)
    if reason:
        raise AppearanceUnavailable(reason)
    backend = _backend(platform)
    try:
        original = backend.get()
    except AppearanceUnavailable:
        backend.close()
        raise
    try:
        yield OsAppearance(backend)
    finally:
        try:
            if backend.get() != original:
                backend.set(original)
        finally:
            backend.close()
