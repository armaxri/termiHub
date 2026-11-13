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
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Iterator, Optional

import pytest

from ..artifacts import ARTIFACT_ROOT
from ..bridge import BridgeError, screenshot_to_png_bytes
from ..display_runner import bring_app_foreground
from ..window_capture import CaptureUnavailable, capture_window, save_png
from ..ui.base import HarnessMixin
from .config import ProductRunInputs, load_inputs
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


def make_profile_home(home: Path) -> Path:
    """Create the scratch home with a plain ``.zshrc`` (no new-user menu)."""
    for sub in (".config", ".local/share", ".local/state", ".cache"):
        (home / sub).mkdir(parents=True, exist_ok=True)
    zshrc = home / ".zshrc"
    if not zshrc.exists():
        zshrc.write_text(_ZSHRC, encoding="utf-8")
    return home


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

