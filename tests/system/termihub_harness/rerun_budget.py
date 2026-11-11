"""Rerun report and per-lane rerun budget for the nightly lanes (#5167, TST-003).

The nightly integration lanes run ``--reruns 2`` (#2698): a test that fails and
then passes on a retry is green. That absorbs runner noise, but it also hides
first-attempt races, and a test that passes one time in three still reads as
green. The rerun count is the lane's flake metric, and the ``-r aR`` console
line used to be its only record.

This module turns it into a gate:

* every run lists the tests that needed a rerun: node id, attempts, final
  outcome and the **first** failure's message. The list goes to the terminal
  summary, to ``<artifacts>/reruns/<lane>.json`` (uploaded with the failure
  artifacts) and to the GitHub step summary as a table;
* a lane that names itself in ``TERMIHUB_SKIP_GUARD_LANE`` (the same switch the
  skip guard uses) fails when its **absorbed** reruns exceed its budget. An
  absorbed rerun is a retry of a test that went on to pass. A test that failed
  after every retry already reds the lane, so its retries are listed but not
  counted.

The budgets are committed fragments in ``tests/system/rerun-budget.d/``, the
same shape as ``skip-allowlist.d/`` (#5033): each file is one JSON object with a
``why`` and ``max_reruns: {lane: count}``. A lane's budget is the **sum** over
the fragments that name it; a lane no fragment names allows no absorbed rerun
(the display-critical lanes run ``--reruns 0`` and need none). The seed
fragments are ``<lane>.json``. A PR that knowingly adds a flaky test adds its
own ``<issue>-<slug>.json`` and never edits a shared number.

Tests that rerun on two consecutive nights get a tracking issue, filed by the
coordinator from the JSON artifact or the step summary. Nothing here files an
issue (maintainer decision 2026-10-26: no bot-filed issues).

The decision logic is pure (:func:`evaluate`) and unit-tested in
``tests/test_rerun_budget.py``; ``conftest.py`` only feeds it the run's reports.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

#: The committed budget fragments (next to ``pyproject.toml``).
BUDGET_DIR = Path(__file__).resolve().parents[1] / "rerun-budget.d"

#: The keys a fragment may carry (plus any ``_``-prefixed comment key).
_FRAGMENT_KEYS = frozenset({"why", "max_reruns"})

#: A first-failure message longer than this is cut (the full text is in the
#: test's ``attempt-1-failure.txt``).
MESSAGE_LIMIT = 300

#: Final outcomes that mean the reruns were *not* absorbed: the lane is red anyway.
_RED = ("failed", "error")


@dataclass(frozen=True)
class Budget:
    """Per lane, the fragments that budget it and how many reruns each adds."""

    sources: Mapping[str, tuple[tuple[str, int], ...]] = field(default_factory=dict)

    def for_lane(self, lane: str) -> int:
        """The lane's rerun budget: the sum over its fragments; 0 when none."""
        return sum(count for _, count in self.sources.get(lane, ()))

    def describe(self, lane: str) -> str:
        return ", ".join(f"{name}: {n}" for name, n in self.sources.get(lane, ())) or "none"

    @property
    def lanes(self) -> set[str]:
        return set(self.sources)


def _parse_fragment(name: str, raw: Any) -> dict[str, int]:
    if not isinstance(raw, Mapping):
        raise ValueError(f"rerun budget fragment {name} must be a JSON object")
    unknown = sorted(k for k in raw if k not in _FRAGMENT_KEYS and not str(k).startswith("_"))
    if unknown:
        raise ValueError(f"rerun budget fragment {name} has unknown key(s) {unknown}")
    why = raw.get("why")
    if not isinstance(why, str) or not why.strip():
        raise ValueError(f"rerun budget fragment {name} needs a 'why'")
    counts = raw.get("max_reruns")
    if not isinstance(counts, Mapping) or not counts:
        raise ValueError(f"rerun budget fragment {name} needs a non-empty 'max_reruns' object")
    budget: dict[str, int] = {}
    for lane, count in counts.items():
        lane = str(lane)
        if lane.startswith("_"):  # a "_comment" documents the numbers
            continue
        if lane == "*":
            raise ValueError(f"rerun budget fragment {name}: a budget names a lane, not '*'")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValueError(
                f"rerun budget fragment {name}: max_reruns[{lane!r}] must be a "
                "non-negative integer"
            )
        budget[lane] = count
    return budget


def parse_fragments(fragments: Mapping[str, Any]) -> Budget:
    """Build a :class:`Budget` from ``{file name: fragment}``, validating each."""
    sources: dict[str, list[tuple[str, int]]] = {}
    for name in sorted(fragments):
        for lane, count in _parse_fragment(name, fragments[name]).items():
            sources.setdefault(lane, []).append((name, count))
    return Budget(sources={lane: tuple(v) for lane, v in sources.items()})


def load_budget(directory: Path = BUDGET_DIR) -> Budget:
    """Load every ``*.json`` fragment in ``directory``; any other file is an error."""
    paths = sorted(directory.iterdir())
    stray = [path.name for path in paths if path.suffix != ".json" or not path.is_file()]
    if stray:
        raise ValueError(f"{directory.name}/ holds only *.json fragments, not {stray}")
    return parse_fragments(
        {path.name: json.loads(path.read_text(encoding="utf-8")) for path in paths}
    )


# ── Recording ────────────────────────────────────────────────────────────────


@dataclass
class Rerun:
    """One test that needed at least one rerun."""

    nodeid: str
    reruns: int = 0
    first_failure: str = ""
    #: ``passed`` / ``failed`` / ``error`` / ``skipped``; ``unknown`` until the
    #: final attempt reports (an interrupted run).
    outcome: str = "unknown"

    @property
    def attempts(self) -> int:
        return self.reruns + 1

    @property
    def absorbed(self) -> bool:
        """The reruns turned a failure green (they count against the budget)."""
        return self.outcome not in _RED

    def to_json(self) -> dict[str, Any]:
        return {
            "nodeid": self.nodeid,
            "attempts": self.attempts,
            "reruns": self.reruns,
            "outcome": self.outcome,
            "absorbed": self.absorbed,
            "first_failure": self.first_failure,
        }


def failure_message(longrepr: Any) -> str:
    """A one-line message out of a failed report's ``longrepr``.

    Prefers the crash line pytest itself shows (``reprcrash.message``), else the
    last ``E   `` line, else the last non-empty line; cut to
    :data:`MESSAGE_LIMIT`.
    """
    message = ""
    crash = getattr(longrepr, "reprcrash", None)
    if crash is not None and getattr(crash, "message", None):
        message = str(crash.message)
    else:
        text = str(longrepr or "")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        errors = [line[1:].strip() for line in lines if line.startswith("E ")]
        message = errors[-1] if errors else (lines[-1] if lines else "")
    message = " ".join(message.split())
    if len(message) > MESSAGE_LIMIT:
        message = message[: MESSAGE_LIMIT - 1] + "…"
    return message


class Recorder:
    """Folds a run's test reports into one :class:`Rerun` per retried test.

    Fed every report on the xdist controller (or the only process), in order:
    a ``rerun`` report per retried attempt, then the final attempt's reports.
    """

    def __init__(self) -> None:
        self.tests: dict[str, Rerun] = {}

    def add_report(self, report: Any) -> None:
        nodeid = report.nodeid
        if report.outcome == "rerun":
            entry = self.tests.setdefault(nodeid, Rerun(nodeid))
            entry.reruns += 1
            if not entry.first_failure:
                entry.first_failure = failure_message(report.longrepr)
            entry.outcome = "unknown"
            return
        entry = self.tests.get(nodeid)
        if entry is None:
            return
        when = getattr(report, "when", "call")
        if report.failed:
            entry.outcome = "failed" if when == "call" else "error"
        elif entry.outcome in _RED:
            return  # a passing teardown after a failed call keeps the failure
        elif report.skipped:
            entry.outcome = "skipped"
        elif when == "call":
            entry.outcome = "passed"

    def sorted(self) -> list[Rerun]:
        return sorted(self.tests.values(), key=lambda t: (-t.reruns, t.nodeid))


# ── Verdict ──────────────────────────────────────────────────────────────────


@dataclass
class Verdict:
    lane: str
    budget: int
    absorbed: int
    total: int
    problems: list[str]

    @property
    def ok(self) -> bool:
        return not self.problems


def evaluate(lane: str, tests: Iterable[Rerun], budget: Budget) -> Verdict:
    """Decide whether ``lane`` stayed within its rerun budget. Pure."""
    tests = list(tests)
    absorbed = sum(t.reruns for t in tests if t.absorbed)
    total = sum(t.reruns for t in tests)
    limit = budget.for_lane(lane)
    problems: list[str] = []
    if absorbed > limit:
        names = ", ".join(t.nodeid for t in tests if t.absorbed)
        problems.append(
            f"{absorbed} absorbed rerun(s) exceed the rerun budget of {limit} for lane "
            f"'{lane}' (sum of max_reruns in {BUDGET_DIR.name}/ — {budget.describe(lane)}). "
            f"Passed only on a retry: {names}"
        )
    return Verdict(lane=lane, budget=limit, absorbed=absorbed, total=total, problems=problems)


# ── Reporting ────────────────────────────────────────────────────────────────


def format_summary(tests: Sequence[Rerun], verdict: Optional[Verdict]) -> list[str]:
    """Terminal-summary lines: every retried test and the budget verdict."""
    lines: list[str] = []
    absorbed = sum(t.reruns for t in tests if t.absorbed)
    total = sum(t.reruns for t in tests)
    lines.append(
        f"{len(tests)} test(s) needed a rerun: {total} rerun(s), "
        f"{absorbed} absorbed (the test then passed)"
    )
    for test in tests:
        lines.append(f"- {test.nodeid}  [{test.attempts} attempts, {test.outcome}]")
        if test.first_failure:
            lines.append(f"    first failure: {test.first_failure}")
    if verdict is not None:
        state = "OK" if verdict.ok else "FAILED"
        lines.append(
            f"rerun budget ({verdict.lane}): {state} — {verdict.absorbed} absorbed of "
            f"{verdict.budget} allowed"
        )
        for problem in verdict.problems:
            lines.append(f"  - {problem}")
        if not verdict.ok:
            lines.append(
                "  Fix the race behind each retried test. Raise the budget only with a "
                f"new fragment in tests/system/{BUDGET_DIR.name}/ that says why (#5167)."
            )
    return lines


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def markdown_summary(lane: str, tests: Sequence[Rerun], verdict: Optional[Verdict]) -> str:
    """The step-summary section: a verdict line and one table row per test."""
    out = [f"## Pytest reruns ({lane})", ""]
    if verdict is not None:
        mark = "within" if verdict.ok else "**over**"
        out.append(
            f"{verdict.absorbed} absorbed rerun(s), {mark} the budget of {verdict.budget} "
            f"({verdict.total} rerun(s) in all)."
        )
        out.append("")
    if not tests:
        out.append("No test needed a rerun.")
        return "\n".join(out) + "\n\n"
    out.append("| Test | Attempts | Final | First failure |")
    out.append("| --- | ---: | --- | --- |")
    for test in tests:
        out.append(
            f"| `{_cell(test.nodeid)}` | {test.attempts} | {test.outcome} | "
            f"{_cell(test.first_failure)} |"
        )
    return "\n".join(out) + "\n\n"


def report_path(root: Path, lane: Optional[str]) -> Path:
    """``<artifacts>/reruns/<lane>.json`` (``local.json`` outside a lane)."""
    name = re.sub(r"[^\w.-]", "_", lane) if lane else "local"
    return root / "reruns" / f"{name}.json"


def write_report(
    path: Path, lane: Optional[str], tests: Sequence[Rerun], verdict: Optional[Verdict]
) -> Optional[Path]:
    """Write the JSON artifact (never raises); ``None`` when it could not."""
    payload: dict[str, Any] = {
        "lane": lane,
        "budget": verdict.budget if verdict else None,
        "absorbed": sum(t.reruns for t in tests if t.absorbed),
        "total": sum(t.reruns for t in tests),
        "ok": verdict.ok if verdict else None,
        "problems": verdict.problems if verdict else [],
        "tests": [t.to_json() for t in tests],
    }
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    except OSError:
        return None
    return path


# ── pytest glue (kept here so conftest.py stays a thin caller) ────────────────


class Gate:
    """One run's recorder, verdict and reports; conftest owns one per session."""

    def __init__(self, lane: Optional[str]) -> None:
        self.lane = lane
        self.recorder = Recorder()
        self.verdict: Optional[Verdict] = None

    def finish(self, budget_loader=load_budget) -> Optional[Verdict]:
        """Evaluate the lane (when one is set); ``None`` outside a lane."""
        if self.lane is None:
            return None
        self.verdict = evaluate(self.lane, self.recorder.tests.values(), budget_loader())
        return self.verdict

    def report(
        self, root: Path, write_line, env: Mapping[str, str] = os.environ
    ) -> Optional[Path]:
        """Print the summary, write the artifact and the step summary.

        In a lane all three happen every run, so the lane always publishes its
        table; outside a lane only when something reran.
        """
        tests = self.recorder.sorted()
        if self.lane is None and not tests:
            return None
        for line in format_summary(tests, self.verdict):
            write_line(line)
        path = write_report(report_path(root, self.lane), self.lane, tests, self.verdict)
        if path is not None:
            write_line(f"details: {path}")
        summary = env.get("GITHUB_STEP_SUMMARY")
        if summary and self.lane is not None:
            try:
                with open(summary, "a", encoding="utf-8") as fh:
                    fh.write(markdown_summary(self.lane, tests, self.verdict))
            except OSError:
                pass
        return path
