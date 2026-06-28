"""Guided-manual test mode core (issue #914).

Manual tests used to live entirely outside the Python harness
(``tests/manual/*.yaml`` + ``scripts/test-manual.py``), so they shared none of
the harness's app/agent orchestration, fixtures, or reporting. This module makes
the *irreducibly-manual* step a first-class concern of a normal ``pytest`` test:
a test marked ``@pytest.mark.manual`` does all the automatable setup through the
existing mixins, then calls :class:`ManualUi` helpers for the human-in-the-loop
part.

Everything here is **app-independent and unit-testable**: the skip decision is a
pure function, the operator prompts read/write injectable streams, and the report
builder takes plain records. The pytest wiring (CLI options, collection skip,
report writing) lives in ``conftest.py``; the operator helpers live in
``termihub_harness.ui.manual``.
"""

from __future__ import annotations

import datetime
import json
import os
import platform as _platform
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional, Sequence


# ── Platform detection (mirrors scripts/test-manual.py) ──────────────────────
def detect_platform() -> str:
    """Return ``'macos'``, ``'linux'``, ``'windows'`` or the raw system name."""
    system = _platform.system().lower()
    if system == "darwin":
        return "macos"
    if system == "linux":
        return "linux"
    if system == "windows" or "MSYSTEM" in os.environ:
        return "windows"
    return system


def detect_arch() -> str:
    """Return a normalized architecture string (``x86_64`` / ``aarch64`` / …)."""
    machine = _platform.machine().lower()
    if machine in ("amd64", "x86_64"):
        return "x86_64"
    if machine in ("arm64", "aarch64"):
        return "aarch64"
    return machine or "unknown"


def detect_os_version() -> str:
    """Return a human-readable OS version string."""
    system = _platform.system()
    if system == "Darwin":
        ver = _platform.mac_ver()[0]
        return f"macOS {ver}" if ver else "macOS"
    if system == "Linux":
        return f"Linux {_platform.release()}"
    if system == "Windows":
        return f"Windows {_platform.version()}"
    return _platform.platform()


# ── Skip decision ────────────────────────────────────────────────────────────
def manual_skip_reason(
    *,
    enabled: bool,
    interactive: bool,
    selected_platform: str,
    platforms: Optional[Sequence[str]],
) -> Optional[str]:
    """Why a ``manual`` test should skip, or ``None`` if it should run.

    Pure so the collection hook in ``conftest`` stays a thin adapter and the
    matrix of cases is unit-tested without launching pytest:

    - ``--manual`` absent → skip (the CI / AI-agent / normal-run default).
    - no interactive TTY → skip (a human must be present to answer prompts).
    - the test declares ``platforms`` and the selected one is not among them.
    """
    if not enabled:
        return "guided-manual test: pass --manual to run (skipped by default)"
    if not interactive:
        return "guided-manual test needs an interactive TTY"
    if platforms and "all" not in platforms and selected_platform not in platforms:
        return (
            f"guided-manual test not applicable to platform '{selected_platform}' "
            f"(declared: {', '.join(platforms)})"
        )
    return None


# ── Operator prompts ─────────────────────────────────────────────────────────
@dataclass
class ManualResult:
    """The outcome the operator gave for one prompt."""

    status: str  # "pass" | "fail" | "skip"
    note: Optional[str] = None


class ManualPrompter:
    """Render an instruction to the console and collect the operator's verdict.

    Both the input and output sides are injectable so the prompting logic is
    exercised in unit tests with scripted answers and a captured buffer — no TTY
    required. In real runs the defaults bind to ``input`` and ``print``.
    """

    def __init__(
        self,
        *,
        input_fn: Callable[[str], str] = input,
        output: Callable[[str], None] = print,
    ) -> None:
        self._input = input_fn
        self._print = output

    # -- public verbs --------------------------------------------------------
    def step(
        self, instruction: str, expected: str, *, screenshot: Optional[str] = None
    ) -> ManualResult:
        """Show the instruction + expected result, wait, then ask pass/fail/skip."""
        self._present("MANUAL STEP", [instruction], expected, screenshot)
        self._read_line("  Perform the step, then press Enter to record the result… ")
        return self._verdict()

    def confirm(self, question: str) -> bool:
        """Ask a yes/no question; ``True`` for yes (EOF / Ctrl-C answers no)."""
        self._present("CONFIRM", [question], "Answer yes or no.", None)
        return self._read_choice("  [y]es / [n]o: ", ("y", "n"), default="n") == "y"

    # -- internals -----------------------------------------------------------
    def _present(
        self,
        title: str,
        lines: Sequence[str],
        expected: str,
        screenshot: Optional[str],
    ) -> None:
        self._print("")
        self._print(f"  ┌─ {title} " + "─" * max(0, 48 - len(title)))
        for line in lines:
            self._print(f"  │ {line}")
        self._print("  │")
        self._print(f"  │ Expected: {expected}")
        if screenshot:
            self._print(f"  │ Screenshot: {screenshot}")
        self._print("  └" + "─" * 50)

    def _read_line(self, prompt: str) -> Optional[str]:
        """Read one line; ``None`` signals EOF / Ctrl-C (operator gave up)."""
        try:
            return self._input(prompt)
        except (EOFError, KeyboardInterrupt):
            return None

    def _read_choice(self, prompt: str, valid: Sequence[str], *, default: str) -> str:
        """Read until a valid single-letter choice; ``default`` on EOF / Ctrl-C.

        The ``default`` floor guarantees termination — a closed or non-interactive
        stream resolves to a safe answer instead of looping forever.
        """
        while True:
            line = self._read_line(prompt)
            if line is None:
                return default
            choice = line.strip().lower()[:1]
            if choice in valid:
                return choice
            self._print(f"  Please enter one of: {', '.join(valid)}")

    def _verdict(self) -> ManualResult:
        choice = self._read_choice(
            "  Result — [p]ass / [f]ail / [s]kip: ", ("p", "f", "s"), default="s"
        )
        if choice == "p":
            return ManualResult("pass")
        if choice == "s":
            return ManualResult("skip")
        note = (self._read_line("  Failure note (optional): ") or "").strip() or None
        return ManualResult("fail", note)


# ── Reporting ────────────────────────────────────────────────────────────────
@dataclass
class ManualRecord:
    """One operator interaction, accumulated across a manual session."""

    nodeid: str
    kind: str  # "step" | "confirm" | "observe"
    instruction: str
    expected: str
    status: str  # "pass" | "fail" | "skip"
    timestamp: str
    note: Optional[str] = None
    screenshot: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "nodeid": self.nodeid,
            "kind": self.kind,
            "instruction": self.instruction,
            "expected": self.expected,
            "status": self.status,
            "timestamp": self.timestamp,
            "note": self.note,
            "screenshot": self.screenshot,
        }


@dataclass
class ManualSession:
    """A live collector the helpers append to; flushed to a report at session end."""

    records: list[ManualRecord] = field(default_factory=list)

    def add(self, record: ManualRecord) -> None:
        self.records.append(record)


def _counts(records: Sequence[ManualRecord]) -> dict[str, int]:
    summary = {"total": len(records), "passed": 0, "failed": 0, "skipped": 0}
    for rec in records:
        key = {"pass": "passed", "fail": "failed", "skip": "skipped"}.get(rec.status)
        if key:
            summary[key] += 1
    return summary


def build_manual_report(
    records: Sequence[ManualRecord],
    *,
    started_at: datetime.datetime,
    completed_at: datetime.datetime,
    selected_platform: Optional[str] = None,
) -> dict:
    """Build the JSON report object (schema aligned with ``scripts/test-manual.py``)."""
    plat = selected_platform or detect_platform()
    return {
        "version": "1",
        "kind": "guided-manual-harness",
        "session": {
            "id": f"session-{started_at.strftime('%Y-%m-%dT%H%M%S')}",
            "started_at": started_at.isoformat(),
            "completed_at": completed_at.isoformat(),
            "duration_seconds": int(
                (completed_at - started_at).total_seconds()
            ),
        },
        "environment": {
            "platform": plat,
            "arch": detect_arch(),
            "os_version": detect_os_version(),
        },
        "summary": _counts(records),
        "results": [rec.to_dict() for rec in records],
    }


def render_markdown(report: dict) -> str:
    """Render a human-readable markdown summary of a manual report."""
    env = report["environment"]
    summary = report["summary"]
    lines = [
        "# Guided-manual test report",
        "",
        f"- **Platform:** {env['os_version']} ({env['platform']}/{env['arch']})",
        f"- **Started:** {report['session']['started_at']}",
        f"- **Completed:** {report['session']['completed_at']}",
        f"- **Results:** {summary['passed']} passed · "
        f"{summary['failed']} failed · {summary['skipped']} skipped "
        f"({summary['total']} total)",
        "",
        "| Result | Test | Step | Note |",
        "| ------ | ---- | ---- | ---- |",
    ]
    icon = {"pass": "✅ pass", "fail": "❌ fail", "skip": "⏭ skip"}
    for rec in report["results"]:
        note = (rec.get("note") or "").replace("|", "\\|")
        instruction = rec["instruction"].replace("|", "\\|")
        lines.append(
            f"| {icon.get(rec['status'], rec['status'])} "
            f"| `{rec['nodeid']}` | {instruction} | {note} |"
        )
    return "\n".join(lines) + "\n"


def write_manual_report(
    records: Sequence[ManualRecord],
    report_dir: Path,
    *,
    started_at: datetime.datetime,
    completed_at: datetime.datetime,
    selected_platform: Optional[str] = None,
) -> Optional[Path]:
    """Write ``manual-<ts>-<plat>-<arch>.{json,md}``; return the JSON path.

    Returns ``None`` when there is nothing to report (no manual interaction ran),
    so the caller emits no empty files on a normal non-manual run.
    """
    if not records:
        return None
    report = build_manual_report(
        records,
        started_at=started_at,
        completed_at=completed_at,
        selected_platform=selected_platform,
    )
    report_dir.mkdir(parents=True, exist_ok=True)
    env = report["environment"]
    ts = completed_at.strftime("%Y-%m-%dT%H%M%S")
    stem = f"manual-{ts}-{env['platform']}-{env['arch']}"
    json_path = report_dir / f"{stem}.json"
    json_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    (report_dir / f"{stem}.md").write_text(render_markdown(report), encoding="utf-8")
    return json_path
