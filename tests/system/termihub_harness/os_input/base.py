"""Backend-independent core of OS-level input injection (#4935).

**Safety contract.** The maintainer runs an installed termiHub on the same
machine as the test instance, and Claude often runs *inside* it. So:

- A target is only ever a **PID** the harness launched (the test instance, or a
  helper window it spawned). A name (``"termiHub"``, a bundle id, a window
  title) is refused with :class:`ByNameTargetRefused` before anything runs.
- Input that the OS routes **by PID** (macOS ``CGEventPostToPid``) needs nothing
  more. Input that goes to *whatever has focus* (XTEST on X11, ``SendInput`` on
  Windows, a global ``CGEventPost`` pointer event on macOS) is **global**: it is
  refused unless the harness runs on a GitHub runner or the operator opted in
  with :data:`GLOBAL_OPT_IN_ENV`, and every single global event is preceded by
  a check that the frontmost window belongs to the intended PID.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Optional, Sequence

#: Opt-in for global (non-PID) injection outside a GitHub runner.
GLOBAL_OPT_IN_ENV = "TERMIHUB_OS_INPUT_GLOBAL"

#: The portable modifier names a key combo may use.
MODIFIERS = frozenset({"ctrl", "shift", "alt", "altgr", "cmd", "super"})


class ByNameTargetRefused(ValueError):
    """A by-name target (app name, bundle id, title) was passed instead of a PID."""


class GlobalInjectionRefused(RuntimeError):
    """Global injection without a GitHub runner / opt-in, or into the wrong window."""


class OsInputUnavailable(RuntimeError):
    """This host cannot inject OS input (missing tool, permission, display)."""


def require_pid(target: object) -> int:
    """Return ``target`` as a PID, refusing anything that is not one.

    A string — ``"termiHub"``, ``"com.armaxri.termihub"``, even ``"1234"`` — is a
    by-name target and is refused: PIDs come from the harness as ints.
    """
    if isinstance(target, bool) or not isinstance(target, int):
        if isinstance(target, str):
            raise ByNameTargetRefused(
                f"refusing by-name input target {target!r}: OS input is only ever "
                "aimed at a PID the harness launched"
            )
        raise ByNameTargetRefused(f"OS input target must be a PID (int), got {target!r}")
    if target <= 0:
        raise ByNameTargetRefused(f"OS input target must be a positive PID, got {target}")
    return target


def global_injection_allowed(env: Optional[Mapping[str, str]] = None) -> bool:
    """Whether global (focus-routed) injection may run on this host."""
    env = os.environ if env is None else env
    return env.get("GITHUB_ACTIONS") == "true" or env.get(GLOBAL_OPT_IN_ENV) == "1"


def parse_combo(combo: str) -> tuple[list[str], str]:
    """Split ``"ctrl+shift+c"`` into ``(["ctrl", "shift"], "c")``.

    Modifiers are the portable names in :data:`MODIFIERS`; the last part is the
    key (a character, or a name like ``enter``, ``escape``, ``caps_lock``).
    ``"+"`` alone, or as the key (``"shift++"``), means the plus key.
    """
    if not combo:
        raise ValueError("empty key combo")
    if combo == "+":
        return [], "+"
    if combo.endswith("++"):
        head, key = combo[:-2], "+"
        parts = [p for p in head.split("+") if p] if head else []
    else:
        *parts, key = combo.split("+")
    mods = [p.lower() for p in parts]
    unknown = [m for m in mods if m not in MODIFIERS]
    if unknown:
        raise ValueError(f"unknown modifier(s) {unknown} in {combo!r}")
    if not key:
        raise ValueError(f"no key in combo {combo!r}")
    return mods, key if len(key) == 1 else key.lower()


@dataclass(frozen=True)
class OsWindow:
    """A top-level window, in the OS's global screen coordinates."""

    handle: int
    pid: int
    x: int
    y: int
    width: int
    height: int
    title: str = ""

    @property
    def center(self) -> tuple[int, int]:
        return self.x + self.width // 2, self.y + self.height // 2

    def contains(self, x: float, y: float) -> bool:
        return self.x <= x < self.x + self.width and self.y <= y < self.y + self.height


class OsInput:
    """Inject real OS input into windows owned by an allowed set of PIDs.

    Subclasses implement the ``_``-prefixed primitives per OS; this class owns
    the safety checks. ``is_global`` says whether the backend's *key* events go
    to the focused window (True) or are routed by PID (False); pointer events
    are always global.
    """

    is_global = True
    #: OS screen units per CSS pixel are ``devicePixelRatio`` (X11, Win32), or 1
    #: (macOS points).
    scale_is_device_pixel_ratio = True

    def __init__(self, pid: int, *, env: Optional[Mapping[str, str]] = None) -> None:
        self.pid = require_pid(pid)
        self._allowed = {self.pid}
        #: 1 for a single click, 2 for the second press of a double-click, ...
        self.click_state = 1
        self._env = env

    # ── PID bookkeeping ──────────────────────────────────────────────────────
    def allow_pid(self, pid: int) -> None:
        """Also allow input into ``pid`` (a helper window the harness spawned)."""
        self._allowed.add(require_pid(pid))

    def retarget(self, pid: int) -> None:
        """Follow the test instance to a new PID after a harness relaunch."""
        self._allowed.discard(self.pid)
        self.pid = require_pid(pid)
        self._allowed.add(self.pid)

    def _check_target(self, pid: Optional[int]) -> int:
        target = self.pid if pid is None else require_pid(pid)
        if target not in self._allowed:
            raise GlobalInjectionRefused(
                f"PID {target} is not the test instance or a harness helper "
                f"(allowed: {sorted(self._allowed)})"
            )
        return target

    def _require_global(self, target: int, *, any_allowed: bool = False) -> None:
        if not global_injection_allowed(self._env):
            raise GlobalInjectionRefused(
                "global OS input is refused outside a GitHub runner; set "
                f"{GLOBAL_OPT_IN_ENV}=1 to opt in on a machine with nothing else "
                "on the display"
            )
        front = self.frontmost_pid()
        ok = front in self._allowed if any_allowed else front == target
        if not ok:
            frontmost = self._describe_frontmost()
            raise GlobalInjectionRefused(
                f"frontmost window belongs to PID {front}, not the intended PID "
                f"{target}; refusing to inject" + (f" (frontmost: {frontmost})" if frontmost else "")
            )

    # ── Public API ───────────────────────────────────────────────────────────
    def windows(self, pid: Optional[int] = None) -> list[OsWindow]:
        """The visible top-level windows of ``pid`` (default: the test instance)."""
        return self._windows(self._check_target(pid))

    def frontmost_pid(self) -> Optional[int]:
        """PID owning the frontmost (focused) top-level window, if any."""
        return self._frontmost_pid()

    def screen_size(self) -> tuple[int, int]:
        """Width and height of the primary screen, in OS screen units."""
        return self._screen_size()

    def frontmost_window(self) -> Optional[int]:
        """Handle of the focused top-level window, or ``None`` if unknowable."""
        return self._frontmost_window()

    def dialog_windows(self, baseline: Iterable[int], pid: Optional[int] = None) -> list[OsWindow]:
        """Windows of ``pid`` that are not in ``baseline`` (handles seen before).

        A native dialog the app opened (GTK file chooser, Windows common file
        dialog) is a top-level window of the app's own PID, so it is found by
        that owner PID, never by its title or class.
        """
        known = set(baseline)
        return [w for w in self.windows(pid) if w.handle not in known]

    def native_dialog_open(self, baseline: Iterable[int], pid: Optional[int] = None) -> bool:
        """Whether ``pid`` shows a native dialog (a window not in ``baseline``).

        The macOS backend also counts a sheet attached to one of its windows.
        """
        return bool(self.dialog_windows(baseline, pid))

    def describe_focus(self) -> str:
        """The focused UI element of the frontmost app (diagnostics; may be empty)."""
        return ""

    def describe_point(self, x: float, y: float) -> str:
        """What the OS would deliver a pointer event at ``(x, y)`` to (diagnostics).

        Read-only. Empty when the backend cannot tell.
        """
        return self._describe_point(int(round(x)), int(round(y)))

    def describe_desktop(self) -> str:
        """Every visible top-level window and the input state (diagnostics).

        Read-only: lists windows of *any* process, so a failure can show what
        covered or took the test instance's input. Empty when unsupported.
        """
        return self._describe_desktop()

    def activate(
        self, pid: Optional[int] = None, *, window: Optional[OsWindow] = None, timeout: float = 10.0
    ) -> None:
        """Bring ``window`` (or ``pid``'s first window) to the front and wait for it."""
        target = self._check_target(window.pid if window is not None else pid)
        exact = window is not None
        if window is None:
            found = self._wait(lambda: self._windows(target), timeout, f"a window of PID {target}")
            window = found[0]
        self._activate(window)
        self._wait(lambda: self._frontmost_pid() == target, timeout, f"PID {target} frontmost")
        chosen = window
        if exact and self._frontmost_window() is not None:
            # Several windows of one PID (multi-window): the PID alone does not
            # prove which of them took the focus. Best effort — a caller that
            # needs proof (calibration) checks where the pointer lands.
            try:
                self._wait(
                    lambda: self._frontmost_window() == chosen.handle,
                    min(timeout, 2.0),
                    f"window {chosen.handle} frontmost",
                )
            except OsInputUnavailable:
                pass
        self._settle()

    def key(self, combo: str, *, pid: Optional[int] = None) -> None:
        """Press and release ``combo`` (``"ctrl+shift+c"``, ``"cmd+q"``, ``"enter"``)."""
        target = self._before_key(pid)
        mods, key = parse_combo(combo)
        self._key(target, mods, key)

    def key_down(self, key: str, *, pid: Optional[int] = None) -> None:
        self._key_state(self._before_key(pid), key, True)

    def key_up(self, key: str, *, pid: Optional[int] = None) -> None:
        self._key_state(self._before_key(pid), key, False)

    def type_text(self, text: str, *, pid: Optional[int] = None) -> None:
        """Type ``text`` (ASCII; ``\\n`` presses Enter) as real key events."""
        target = self._before_key(pid)
        self._type(target, text)

    def pointer_move(self, x: float, y: float, *, pid: Optional[int] = None) -> None:
        """Move the OS pointer to global screen ``(x, y)``."""
        self._pointer_move(self._before_pointer(pid), int(round(x)), int(round(y)))

    def pointer_button(self, down: bool, *, button: str = "left", pid: Optional[int] = None) -> None:
        self._pointer_button(self._before_pointer(pid), button, down)

    def click(
        self, x: float, y: float, *, button: str = "left", count: int = 1, pid: Optional[int] = None
    ) -> None:
        """Move to ``(x, y)`` and click ``count`` times with ``button``."""
        self.pointer_move(x, y, pid=pid)
        try:
            for index in range(1, count + 1):
                # macOS counts multi-clicks from a field on the event itself.
                self.click_state = index
                self.pointer_button(True, button=button, pid=pid)
                self.pointer_button(False, button=button, pid=pid)
                time.sleep(0.05)
        finally:
            self.click_state = 1

    def drag(
        self,
        start: tuple[float, float],
        end: tuple[float, float],
        *,
        steps: int = 20,
        pid: Optional[int] = None,
        hold: float = 0.15,
    ) -> None:
        """Press at ``start``, move in ``steps`` to ``end`` and release there."""
        self.pointer_move(*start, pid=pid)
        self.pointer_button(True, pid=pid)
        time.sleep(hold)
        try:
            for point in drag_path(start, end, steps):
                self.pointer_move(*point, pid=pid)
                time.sleep(0.02)
            time.sleep(hold)
        finally:
            # Always release, even if a frontmost check refused a move: a held
            # button would otherwise outlive the test.
            self._pointer_button(self._check_target(pid), "left", False)

    # ── Safety plumbing ──────────────────────────────────────────────────────
    def _before_key(self, pid: Optional[int]) -> int:
        target = self._check_target(pid)
        if self.is_global:
            self._require_global(target)
        return target

    def _before_pointer(self, pid: Optional[int]) -> int:
        # A pointer event lands wherever it is aimed, not on the focused window
        # (a click into an inactive window is a grade of its own), so it only
        # needs a harness-owned window frontmost — the test instance or a helper.
        target = self._check_target(pid)
        self._require_global(target, any_allowed=True)
        return target

    @staticmethod
    def _wait(predicate: Callable[[], object], timeout: float, what: str):
        deadline = time.monotonic() + timeout
        while True:
            value = predicate()
            if value:
                return value
            if time.monotonic() >= deadline:
                raise OsInputUnavailable(f"timed out after {timeout}s waiting for {what}")
            time.sleep(0.1)

    @staticmethod
    def _settle() -> None:
        time.sleep(0.2)

    # ── Per-OS primitives ────────────────────────────────────────────────────
    def _windows(self, pid: int) -> list[OsWindow]:
        raise NotImplementedError

    def _frontmost_pid(self) -> Optional[int]:
        raise NotImplementedError

    def _screen_size(self) -> tuple[int, int]:
        raise NotImplementedError

    def _frontmost_window(self) -> Optional[int]:
        """Handle of the focused top-level window, or ``None`` if unknowable."""
        return None

    def _describe_point(self, x: int, y: int) -> str:
        return ""

    def _describe_frontmost(self) -> str:
        """The frontmost window, for a refusal message (empty when unknown)."""
        return ""

    def _describe_desktop(self) -> str:
        return ""

    def _activate(self, window: OsWindow) -> None:
        raise NotImplementedError

    def _key(self, pid: int, mods: Sequence[str], key: str) -> None:
        raise NotImplementedError

    def _key_state(self, pid: int, key: str, down: bool) -> None:
        raise NotImplementedError

    def _type(self, pid: int, text: str) -> None:
        raise NotImplementedError

    def _pointer_move(self, pid: int, x: int, y: int) -> None:
        raise NotImplementedError

    def _pointer_button(self, pid: int, button: str, down: bool) -> None:
        raise NotImplementedError


def drag_path(
    start: tuple[float, float], end: tuple[float, float], steps: int
) -> Iterable[tuple[int, int]]:
    """Integer points from just after ``start`` to ``end`` in ``steps`` moves."""
    steps = max(1, steps)
    (x0, y0), (x1, y1) = start, end
    for i in range(1, steps + 1):
        t = i / steps
        yield int(round(x0 + (x1 - x0) * t)), int(round(y0 + (y1 - y0) * t))
