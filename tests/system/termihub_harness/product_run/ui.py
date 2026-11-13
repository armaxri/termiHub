"""``ProductRunUi``: record a product-run suite step by step (#5518).

A product-run suite is an ordinary :class:`~termihub_harness.SystemTest` suite
(one app per class, the usual ``*Ui`` mixins) that lists ``ProductRunUi`` first
and wraps each graded check in :meth:`ProductRunUi.step`::

    with self.step("checklist.banner.wording", "Crash banner wording",
                   expect="the crash banner with Close, Export… and View report"):
        assert self.driver.get_text(CRASH_NOTICE_DISMISS) == "Close"

Each step is written to the run's live record as it starts and ends, gets a
capture of the test window (by the app's PID, never by name) and may add
evidence lines. A failed assertion fails the *step* and the suite carries on;
the test method fails at its end when any of its steps failed, so pytest's exit
code still tells the truth. A step whose input is missing is recorded
*not tested* with the reason (:meth:`not_tested`).

The app runs in a fresh, isolated profile: the harness's own temporary
``TERMIHUB_CONFIG_DIR`` / ``TERMIHUB_LOG_DIR``, plus a scratch ``HOME``,
``XDG_*``, ``ZDOTDIR`` and ``HISTFILE`` under the run directory, and an own OS
keychain namespace (``TERMIHUB_DEV_NAME=product-run-<run id>``), so nothing the
run does reaches the user's dotfiles, shell history or keychain items.
"""

from __future__ import annotations

import contextlib
import datetime
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, ClassVar, Iterator, Optional

import pytest

from ..artifacts import ARTIFACT_ROOT
from ..bridge import BridgeError, screenshot_to_png_bytes
from ..display_runner import bring_app_foreground
from ..window_capture import CaptureUnavailable, capture_window, save_png
from ..ui.base import HarnessMixin
from .config import ProductRunInputs, load_inputs
from .grades import (
    drop_separator_problems,
    painted_terminal_problems,
    reconnect_wording_problems,
)
from .hover import Hover, hovered
from .recorder import Recorder, recorder_from_env, unattended

#: Environment variable the runner sets to the run's keychain namespace tag.
DEV_NAME_ENV = "TERMIHUB_PRODUCT_RUN_DEV_NAME"
#: How long a human step waits for the operator before it counts as not tested.
HUMAN_TIMEOUT = 600.0

_ZSHRC = 'HISTFILE="$HOME/.zsh_history"\nPROMPT=\'%F{cyan}product-run%f %1~ %# \'\n'


def _fallback_run_dir() -> Path:
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return ARTIFACT_ROOT / "product-run" / stamp


def run_recorder() -> Recorder:
    """The run's recorder: the runner's run dir, else a fresh one (direct pytest)."""
    recorder = recorder_from_env()
    if recorder is None:
        run_dir = _fallback_run_dir()
        os.environ["TERMIHUB_PRODUCT_RUN_DIR"] = str(run_dir)
        recorder = Recorder(run_dir)
    return recorder


def run_dev_name(run_dir: Path) -> str:
    """The keychain namespace tag (≤32 chars, see ``keychain_namespace.rs``)."""
    return os.environ.get(DEV_NAME_ENV, "").strip() or f"product-run-{run_dir.name}"[:32]


def profile_env(home: Path, dev_name: str) -> dict[str, str]:
    """The scratch shell profile + keychain namespace the run's app gets."""
    return {
        "HOME": str(home),
        "ZDOTDIR": str(home),
        "HISTFILE": str(home / ".zsh_history"),
        "SHELL_SESSION_HISTORY": "0",
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "TERMIHUB_DEV_NAME": dev_name,
    }


def make_profile_home(home: Path, *, account_home: Optional[Path] = None) -> Path:
    """Create the scratch home with a plain ``.zshrc`` (no new-user menu).

    On macOS the Security framework finds the default (login) keychain under
    ``$HOME/Library/Keychains``; with a bare scratch ``HOME`` every keychain
    write fails ("A default keychain could not be found", OSStatus -25307,
    #5608). So that one directory is linked to the account's real one. Nothing
    in it is changed: the app writes only under the run's own service, which
    ``product-run.sh`` removes at the end, and the default keychain and search
    list stay as they are.
    """
    for sub in (".config", ".local/share", ".local/state", ".cache"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    zshrc = home / ".zshrc"
    if not zshrc.exists():
        zshrc.write_text(_ZSHRC, encoding="utf-8")
    if sys.platform == "darwin":
        import pwd  # POSIX-only

        real = (account_home or Path(pwd.getpwuid(os.getuid()).pw_dir)) / "Library" / "Keychains"
        link = home / "Library" / "Keychains"
        if real.is_dir() and not link.exists() and not link.is_symlink():
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(real, target_is_directory=True)
    return home


#: Docker-backed steps; named in the setup hint when no container runtime runs.
DOCKER_HINT = (
    "No container runtime (Docker or Podman) is running, so the Docker-backed SSH steps "
    "(password and two-factor login) are not tested. Start Docker Desktop (or Podman / "
    "Colima) before the run if you want them: the run never starts a VM itself."
)

_SETUP_HINTS_DONE = False


def record_setup_hints(
    recorder: Recorder, *, runtime: Optional[Callable[[], Optional[str]]] = None
) -> None:
    """Check the run's optional setup once and list what is missing on the page."""
    global _SETUP_HINTS_DONE
    if _SETUP_HINTS_DONE:
        return
    _SETUP_HINTS_DONE = True
    if runtime is None:
        from ..fixtures import container_runtime as runtime
    if runtime() is None:
        recorder.add_hint("docker", DOCKER_HINT)
        print(f"[product-run] setup hint: {DOCKER_HINT}", flush=True)


def notify_operator(title: str, message: str) -> None:
    """Post a desktop notification so a waiting human step is noticed (macOS).

    Best effort and never fatal: the progress page shows the step either way.
    Uses ``osascript``'s ``display notification`` (no app is addressed).
    """
    if sys.platform != "darwin" or os.environ.get("TERMIHUB_PRODUCT_RUN_NO_NOTIFY") == "1":
        return

    def quoted(text: str) -> str:
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'

    script = f"display notification {quoted(message[:200])} with title {quoted(title)} sound name \"Glass\""
    try:
        subprocess.run(["osascript", "-e", script], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def failed_steps_of(instance: object) -> list[str]:
    """The steps a product-run test instance recorded as failed (for conftest)."""
    return list(getattr(instance, "_failed_steps", None) or [])


class ProductRunUi(HarnessMixin):
    """Live step recording, screenshots and human steps for a product-run suite."""

    #: The phase name shown on the progress page (override per suite).
    phase: ClassVar[str] = "product run"
    recorder: ClassVar[Recorder]
    inputs: ClassVar[ProductRunInputs]
    profile_home: ClassVar[Path]
    _failed_steps: list[str]

    if TYPE_CHECKING:  # supplied by SystemTest
        app: Any

    @classmethod
    def extra_app_env(cls, request: pytest.FixtureRequest) -> dict[str, str]:
        recorder = run_recorder()
        home = make_profile_home(recorder.run_dir / "profile" / cls.__name__ / "home")
        dev_name = run_dev_name(recorder.run_dir)
        inputs = load_inputs()
        recorder.start(
            run_id=recorder.run_dir.name,
            inputs=inputs.summary(),
            profile={"dev_name": dev_name, "home": str(home)},
        )
        record_setup_hints(recorder)
        cls.recorder = recorder
        cls.inputs = inputs
        cls.profile_home = home
        return {**super().extra_app_env(request), **profile_env(home, dev_name)}  # type: ignore[misc]

    @pytest.fixture(autouse=True)
    def _product_run_test(self) -> Iterator[None]:
        # conftest's pytest_pyfunc_call fails the test (in its call phase) when
        # any step in it failed; see failed_steps_of.
        self._failed_steps = []
        yield

    # ── steps ─────────────────────────────────────────────────────────────────
    @contextlib.contextmanager
    def step(
        self,
        step_id: str,
        title: str,
        *,
        expect: str = "",
        screenshot: bool = True,
    ) -> Iterator[None]:
        """Record one graded step; see the module docstring.

        ``expect`` says what the screen should show at the end of the step (it
        goes to the screenshot manifest for the UI review). A step that builds on
        an earlier one calls :meth:`require` first.
        """
        rec = self.recorder
        rec.begin(step_id, title, phase=self.phase, expect=expect)
        started = time.monotonic()
        try:
            yield
        except pytest.skip.Exception as exc:
            rec.end(step_id, "not-tested", reason=str(exc) or "skipped")
            return
        except Exception as exc:  # noqa: BLE001 - any error fails the step, not the run
            message = str(exc).strip() or type(exc).__name__
            if not isinstance(exc, (AssertionError, BridgeError)):
                message = f"{type(exc).__name__}: {message}"
            rec.evidence(step_id, f"FAILED: {message}")
            if screenshot:
                self.shot(step_id, label="failure")
            rec.end(step_id, "fail", reason=message.splitlines()[0][:300] if message else None)
            self._failed_steps.append(step_id)
            return
        if screenshot:
            self.shot(step_id)
        rec.evidence(step_id, f"took {time.monotonic() - started:.1f}s")
        rec.end(step_id, "pass")

    def _current_step(self) -> str:
        return self.recorder.load()["steps"][-1]["id"]

    def evidence(self, text: str, step_id: Optional[str] = None) -> None:
        """Add one evidence line to the current (or the named) step."""
        self.recorder.evidence(step_id or self._current_step(), text)

    def not_tested(self, step_id: str, title: str, reason: str) -> None:
        """Record a step that cannot run here, with the reason."""
        self.recorder.not_tested(step_id, title, phase=self.phase, reason=reason)

    def require(self, *step_ids: str) -> None:
        """Inside a step: mark it *not tested* (blocked) unless ``step_ids`` passed."""
        bad = [s for s in step_ids if self.recorder.step_status(s) != "pass"]
        if bad:
            raise pytest.skip.Exception("blocked: " + ", ".join(bad) + " did not pass")

    # ── screenshots ───────────────────────────────────────────────────────────
    def shot(self, step_id: Optional[str] = None, *, label: Optional[str] = None) -> Optional[Path]:
        """Capture the test window for a step; ``None`` when nothing could be captured.

        The window is found by the app's PID (macOS: brought to the front by PID
        first, since WKWebView only paints in the foreground). When the OS
        capture is unavailable the DOM screenshot is saved instead and the
        manifest says so (``source: "dom"``; it lacks the terminal canvas).
        """
        step_id = step_id or self._current_step()
        path = self.recorder.shot_path(step_id, label)
        meta: dict[str, Any] = {"label": label, "theme": self._theme_name()}
        meta.update(self._viewport())
        pid = getattr(self.app, "pid", None)
        try:
            if pid:
                bring_app_foreground(pid)
            frame = capture_window(pid)
            save_png(frame, path)
            meta.update(source="window", width=frame.width, height=frame.height)
        except CaptureUnavailable as exc:
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(screenshot_to_png_bytes(self.driver.screenshot(timeout=20)))
                meta.update(source="dom", capture_note=f"window capture unavailable: {exc}")
            except (BridgeError, ValueError, OSError) as dom_exc:
                self.recorder.evidence(step_id, f"no screenshot: {exc}; DOM: {dom_exc}")
                return None
        self.recorder.add_screenshot(step_id, path, meta)
        return path

    def _theme_name(self) -> Optional[str]:
        try:
            from ..ui.settings import SETTINGS_REGION

            return self.projection_region_cache(SETTINGS_REGION).get("theme") or "default"  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - metadata is best-effort
            return None

    def _viewport(self) -> dict[str, Any]:
        try:
            width = self.driver.get_computed_style("width")
            height = self.driver.get_computed_style("height")
            return {"window_css": {"width": width, "height": height}}
        except BridgeError:
            return {}

    # ── terminal paint ────────────────────────────────────────────────────────
    def assert_terminal_painted(self, tab_id: str, *expected: str, timeout: float = 15.0) -> None:
        """Wait until every ``expected`` text is *visible* in the tab, not only buffered.

        Grades the rendered terminal (#5620): the element mounted in its panel
        slot with a visible area, and the texts on the rows the renderer paints
        (see :func:`~.grades.painted_terminal_problems`). Adds an evidence line;
        fails the step with what kept the text from showing.
        """
        last: list[str] = []

        def painted() -> bool:
            nonlocal last
            try:
                measure = self.driver.measure_terminal(tab_id)
                rows = [r.get("text", "") for r in self.driver.read_terminal_cells(tab_id=tab_id)]
            except BridgeError as exc:
                last = [f"unreadable: {exc}"]
                return False
            last = painted_terminal_problems(measure, rows, list(expected))
            return not last

        try:
            self.wait(painted, timeout=timeout, interval=0.5, what="the terminal to paint")
        except AssertionError as exc:
            raise AssertionError(f"terminal {tab_id} not painted: {'; '.join(last)}") from exc
        self.evidence(f"painted (slot + rendered rows): {', '.join(expected)}")

    def assert_drop_marked(
        self, tab_id: str, kind: str, *, reconnected: bool = True, timeout: float = 15.0
    ) -> None:
        """Wait until the tab's scrollback marks the drop as a drop, not a process exit.

        ``kind`` is ``network`` or ``serial`` (#5619); with ``reconnected`` the
        ``— reconnected hh:mm:ss —`` marker must follow too (#5660). See
        :func:`~.grades.drop_separator_problems`.
        """
        last: list[str] = []

        def marked() -> bool:
            nonlocal last
            last = drop_separator_problems(
                self.driver.read_terminal(tab_id), kind, reconnected=reconnected
            )
            return not last

        try:
            self.wait(marked, timeout=timeout, interval=0.5, what="the drop separators")
        except AssertionError as exc:
            raise AssertionError(f"terminal {tab_id}: {'; '.join(last)}") from exc
        self.evidence(f"scrollback marks the {kind} drop" + (" and the reconnect" if reconnected else ""))

    def assert_reconnect_wording(self, *, serial: bool = False, timeout: float = 20.0) -> None:
        """Grade the shown reconnect notice's wording for its transport (#5619).

        Waits for the notice, then fails with what the text gets wrong (see
        :func:`~.grades.reconnect_wording_problems`).
        """
        notice = "terminal-disconnect-overlay"
        self.wait(lambda: self.driver.exists(notice), timeout=timeout, what="the reconnect notice")
        text = self.driver.get_text(notice)
        self.evidence(f"reconnect notice: {text!r}")
        problems = reconnect_wording_problems(text, serial=serial)
        assert not problems, "; ".join(problems)

    # ── hover ─────────────────────────────────────────────────────────────────
    @contextlib.contextmanager
    def hovered(self, test_id: str) -> Iterator[Hover]:
        """Hover ``test_id`` for the block (real pointer when allowed, see :mod:`.hover`).

        Adds the evidence line saying how it was hovered.
        """
        with hovered(self.driver, getattr(self.app, "pid", None), test_id) as how:
            self.evidence(how.note)
            yield how

    # ── human steps ───────────────────────────────────────────────────────────
    def human_step(
        self,
        instruction: str,
        expected: str,
        *,
        step_id: Optional[str] = None,
        timeout: float = HUMAN_TIMEOUT,
    ) -> str:
        """Ask the operator to act (OS sheet, physical action) and wait.

        The progress page shows the prompt with Done / It did not work / Skip.
        Returns ``"done"``, ``"failed"`` or ``"skip"``; an unattended run or no
        answer within ``timeout`` raises ``pytest.skip`` (the step becomes
        *not tested*). ``"failed"`` raises ``AssertionError`` (the step fails).
        """
        step_id = step_id or self._current_step()
        if unattended():
            raise pytest.skip.Exception(f"needs a human ({instruction}); unattended run")
        token = self.recorder.request_human(step_id, instruction, expected)
        notify_operator("termiHub product run: your turn", instruction)
        answer_file = self.recorder.human_dir / f"{token}.json"
        print(
            f"\n[product-run] YOUR TURN: {instruction}\n  expected: {expected}\n"
            f"  answer on the progress page, or: echo '{{\"result\":\"done\"}}' > {answer_file}",
            flush=True,
        )
        answer = self.recorder.wait_human(token, timeout=timeout)
        self.recorder.evidence(step_id, f"human step: {instruction} -> {answer}")
        if answer is None:
            raise pytest.skip.Exception(f"no answer to a human step within {timeout:.0f}s")
        result = str(answer.get("result", "done"))
        if result == "failed":
            raise AssertionError(f"the operator reported: {answer.get('note') or 'it did not work'}")
        if result == "skip":
            raise pytest.skip.Exception("the operator skipped this step")
        return result

