"""The product run's live record: status, results, screenshot manifest (#5518).

One run owns one directory (``$TERMIHUB_PRODUCT_RUN_DIR``)::

    <run>/
      index.html        the live progress page (copied from page.html)
      status.json       the whole run so far, rewritten after every change
      status.js         the same, as ``window.__productRun(...)`` for a file:// page
      results.json      the final status, written when the run finishes
      shots/<step>.png  one capture per step (more as <step>--<label>.png)
      shots/manifest.json  step context per screenshot, for UI-review agents
      human/<token>.json   a human step's answer (the page's Done button, or by hand)

Every write is atomic (temp file + rename), so the page and the coordinator
never read half a file. The recorder is plain file I/O with an injectable clock,
so it is unit-tested in the normal lane (``tests/test_product_run_machinery.py``).

Step statuses: ``running``, ``pass``, ``fail``, ``not-tested`` (with a reason)
and ``human`` (waiting for the operator). A human's verdict is stored as
``pass`` / ``fail`` with ``graded_by: "human"``.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

#: Environment variable the runner sets to the run directory.
RUN_DIR_ENV = "TERMIHUB_PRODUCT_RUN_DIR"
#: ``1`` = nobody is watching: human steps are recorded not-tested at once.
UNATTENDED_ENV = "TERMIHUB_PRODUCT_RUN_UNATTENDED"

SCHEMA = 1
STATUSES = ("running", "pass", "fail", "not-tested", "human")
FINAL_STATUSES = ("pass", "fail", "not-tested")
PAGE_TEMPLATE = Path(__file__).with_name("page.html")


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def safe_step_id(step_id: str) -> str:
    """A step id usable as a file stem (letters, digits, ``.``, ``-``, ``_``)."""
    cleaned = "".join(c if c.isalnum() or c in "._-" else "-" for c in step_id)
    return cleaned.strip(".-") or "step"


class Recorder:
    """Reads and rewrites one run's ``status.json``; never holds state in memory
    beyond one update, so several suites (and a restarted pytest) share a run."""

    def __init__(self, run_dir: Path, *, clock: Callable[[], str] = _now) -> None:
        self.run_dir = Path(run_dir)
        self._clock = clock
        self.status_path = self.run_dir / "status.json"
        self.shots_dir = self.run_dir / "shots"
        self.human_dir = self.run_dir / "human"

    # ── run lifecycle ─────────────────────────────────────────────────────────
    def start(self, *, run_id: str, inputs: dict[str, Any], profile: dict[str, Any]) -> None:
        """Create the run's files (idempotent: an existing run keeps its steps)."""
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.shots_dir.mkdir(exist_ok=True)
        self.human_dir.mkdir(exist_ok=True)
        if PAGE_TEMPLATE.is_file():
            shutil.copyfile(PAGE_TEMPLATE, self.run_dir / "index.html")
        if self.status_path.is_file():
            self._update(lambda doc: doc.update(state="running"))
            return
        doc = {
            "schema": SCHEMA,
            "run_id": run_id,
            "run_dir": str(self.run_dir),
            "state": "running",
            "started_at": self._clock(),
            "updated_at": self._clock(),
            "finished_at": None,
            "inputs": inputs,
            "profile": profile,
            "current": None,
            "human": None,
            "steps": [],
            "summary": {},
        }
        self._save(doc)

    def finish(self, *, state: str = "finished", exit_status: Optional[int] = None) -> dict:
        """Mark the run done, close any running step, and write ``results.json``."""

        def close(doc: dict) -> None:
            for step in doc["steps"]:
                if step["status"] in ("running", "human"):
                    step["status"] = "not-tested"
                    step["reason"] = step.get("reason") or "the run ended before this step did"
                    step["ended_at"] = self._clock()
            doc.update(state=state, finished_at=self._clock(), current=None, human=None)
            doc["exit_status"] = exit_status

        doc = self._update(close)
        _write_atomic(self.run_dir / "results.json", json.dumps(doc, indent=2) + "\n")
        return doc

    # ── steps ─────────────────────────────────────────────────────────────────
    def begin(self, step_id: str, title: str, *, phase: str, expect: str = "") -> None:
        """Start (or restart) a step; it becomes the run's current step."""

        def add(doc: dict) -> None:
            doc["steps"] = [s for s in doc["steps"] if s["id"] != step_id]
            doc["steps"].append(
                {
                    "id": step_id,
                    "phase": phase,
                    "title": title,
                    "expect": expect,
                    "status": "running",
                    "evidence": [],
                    "reason": None,
                    "screenshots": [],
                    "graded_by": "harness",
                    "started_at": self._clock(),
                    "ended_at": None,
                }
            )
            doc["current"] = step_id

        self._update(add)

    def evidence(self, step_id: str, text: str) -> None:
        """Append one line of evidence (what was measured) to a step."""
        self._update(lambda doc: self._step(doc, step_id)["evidence"].append(str(text)))

    def end(
        self,
        step_id: str,
        status: str,
        *,
        reason: Optional[str] = None,
        graded_by: Optional[str] = None,
    ) -> None:
        """Settle a step: ``pass`` / ``fail`` / ``not-tested`` (with ``reason``)."""
        if status not in FINAL_STATUSES:
            raise ValueError(f"not a final step status: {status!r}")

        def settle(doc: dict) -> None:
            step = self._step(doc, step_id)
            step.update(status=status, ended_at=self._clock())
            if reason is not None:
                step["reason"] = reason
            if graded_by is not None:
                step["graded_by"] = graded_by
            if doc.get("current") == step_id:
                doc["current"] = None

        self._update(settle)

    def not_tested(self, step_id: str, title: str, *, phase: str, reason: str) -> None:
        """Record a step that cannot run here (missing input, not built yet)."""
        self.begin(step_id, title, phase=phase)
        self.end(step_id, "not-tested", reason=reason)

    def step_status(self, step_id: str) -> Optional[str]:
        for step in self.load()["steps"]:
            if step["id"] == step_id:
                return step["status"]
        return None

    # ── screenshots ───────────────────────────────────────────────────────────
    def shot_path(self, step_id: str, label: Optional[str] = None) -> Path:
        """Where a step's next screenshot goes (never overwrites an earlier one)."""
        stem = safe_step_id(step_id) + (f"--{safe_step_id(label)}" if label else "")
        path = self.shots_dir / f"{stem}.png"
        n = 2
        while path.exists():
            path = self.shots_dir / f"{stem}-{n}.png"
            n += 1
        return path

    def add_screenshot(self, step_id: str, path: Path, meta: dict[str, Any]) -> None:
        """Attach a saved screenshot to its step and to ``shots/manifest.json``."""
        rel = path.relative_to(self.run_dir).as_posix()
        self._update(lambda doc: self._step(doc, step_id)["screenshots"].append(rel))
        manifest_path = self.shots_dir / "manifest.json"
        manifest = self._read_json(manifest_path) or {"schema": SCHEMA, "shots": []}
        step = self._step(self.load(), step_id)
        manifest["shots"].append(
            {
                "file": rel,
                "step": step_id,
                "phase": step["phase"],
                "title": step["title"],
                "expect": step["expect"],
                **meta,
            }
        )
        _write_atomic(manifest_path, json.dumps(manifest, indent=2) + "\n")

    # ── human steps ───────────────────────────────────────────────────────────
    def request_human(self, step_id: str, instruction: str, expected: str) -> str:
        """Ask the operator (the page shows it with a Done button); returns the token."""
        token = uuid.uuid4().hex[:12]

        def ask(doc: dict) -> None:
            self._step(doc, step_id)["status"] = "human"
            doc["human"] = {
                "step": step_id,
                "token": token,
                "instruction": instruction,
                "expected": expected,
                "answer_file": f"human/{token}.json",
                "asked_at": self._clock(),
            }

        self._update(ask)
        return token

    def wait_human(
        self, token: str, *, timeout: float, poll: float = 0.5
    ) -> Optional[dict[str, Any]]:
        """Wait for the answer to ``token``; ``None`` on timeout. Clears the prompt."""
        answer_path = self.human_dir / f"{token}.json"
        deadline = time.monotonic() + timeout
        answer = None
        while time.monotonic() < deadline:
            if answer_path.is_file():
                answer = self._read_json(answer_path) or {"result": "done"}
                break
            time.sleep(poll)
        self._update(lambda doc: doc.update(human=None))
        return answer

    # ── file plumbing ─────────────────────────────────────────────────────────
    def load(self) -> dict:
        doc = self._read_json(self.status_path)
        if doc is None:
            raise FileNotFoundError(f"no product run at {self.run_dir} (start() first)")
        return doc

    @staticmethod
    def _read_json(path: Path) -> Optional[dict]:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    @staticmethod
    def _step(doc: dict, step_id: str) -> dict:
        for step in doc["steps"]:
            if step["id"] == step_id:
                return step
        raise KeyError(f"no step {step_id!r} in this run")

    def _update(self, change: Callable[[dict], Any]) -> dict:
        doc = self.load()
        change(doc)
        self._save(doc)
        return doc

    def _save(self, doc: dict) -> None:
        doc["updated_at"] = self._clock()
        counts = {status: 0 for status in STATUSES}
        for step in doc["steps"]:
            counts[step["status"]] = counts.get(step["status"], 0) + 1
        doc["summary"] = counts
        text = json.dumps(doc, indent=2)
        _write_atomic(self.status_path, text + "\n")
        _write_atomic(self.run_dir / "status.js", f"window.__productRun({text});\n")


def recorder_from_env() -> Optional[Recorder]:
    """The run's recorder when the runner set ``$TERMIHUB_PRODUCT_RUN_DIR``."""
    run_dir = os.environ.get(RUN_DIR_ENV, "").strip()
    return Recorder(Path(run_dir)) if run_dir else None


def unattended() -> bool:
    return os.environ.get(UNATTENDED_ENV, "").strip().lower() in ("1", "true", "yes", "on")
