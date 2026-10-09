"""Skip guard for the nightly integration lanes (#4315, TIN2-001 / WA-CI2-003).

A skipped test is green. That is right for an environment gap a lane can never
close (a Windows-only feature on Linux, no Linux container daemon on the macOS
runner, a guided-manual test that needs an operator) and wrong for everything
else: a fixture that never came up, a sidecar that was not built, a display that
was not there. Those skips once hid ~100 Docker-backed suites for days (#4103)
and every deployed-agent suite for weeks (#4092) without turning anything red.

This module decides, from the skips one run produced, whether the lane is
honest. A lane opts in by name (``TERMIHUB_SKIP_GUARD_LANE``, set per step in
``.github/workflows/system-integration.yml``) and the committed allowlist
``tests/system/skip-allowlist.json`` says, for that lane:

* which skip reasons are **expected**, each with a ``why`` — any other skip
  reason fails the lane;
* a ``max_skips`` baseline — more skips than that fails the lane even when each
  reason is allowlisted (a new environment gap is a decision, not an accident).

Independently of the allowlist, a lane that collected nothing, or whose every
collected test skipped, fails: a suite that ran zero tests proves nothing.

``TERMIHUB_REQUIRE_FIXTURES=1`` (set on the Linux step, where the Docker
fixtures must run) additionally fails on any "fixture(s) unavailable" skip, even
one a careless allowlist entry would have admitted.

The decision logic is pure (:func:`evaluate`) so it is unit-tested against fake
collections in ``tests/test_skip_guard.py``; ``conftest.py`` only feeds it the
run's reports and prints the result.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

#: Env switch: the lane name to enforce (e.g. ``bulk-linux``). Unset = off.
LANE_ENV = "TERMIHUB_SKIP_GUARD_LANE"

#: Env switch: ``1`` fails the run on any "fixture(s) unavailable" skip.
REQUIRE_FIXTURES_ENV = "TERMIHUB_REQUIRE_FIXTURES"

#: The committed allowlist (next to ``pyproject.toml``).
ALLOWLIST_PATH = Path(__file__).resolve().parents[1] / "skip-allowlist.json"

#: Matches the skip reason every container fixture helper uses when it skips.
FIXTURE_UNAVAILABLE = re.compile(r"fixtures? unavailable", re.IGNORECASE)

_TRUTHY = ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Skip:
    """One skipped test (or skipped module) and the reason it gave."""

    nodeid: str
    reason: str


@dataclass(frozen=True)
class AllowEntry:
    """One expected skip: ``reason`` (and optionally ``nodeid``) are regexes,
    matched with :func:`re.search`; ``lanes`` lists the lanes it applies to
    (``"*"`` = all)."""

    reason: str
    why: str
    lanes: tuple[str, ...] = ("*",)
    nodeid: Optional[str] = None

    def applies_to(self, lane: str) -> bool:
        return "*" in self.lanes or lane in self.lanes

    def matches(self, skip: Skip) -> bool:
        if not re.search(self.reason, skip.reason):
            return False
        return self.nodeid is None or re.search(self.nodeid, skip.nodeid) is not None


@dataclass(frozen=True)
class Allowlist:
    entries: tuple[AllowEntry, ...]
    max_skips: Mapping[str, int] = field(default_factory=dict)

    def for_lane(self, lane: str) -> list[AllowEntry]:
        return [entry for entry in self.entries if entry.applies_to(lane)]


@dataclass
class Verdict:
    """The outcome of :func:`evaluate`: ``problems`` empty = the lane is honest."""

    lane: str
    collected: int
    skips: list[Skip]
    unexpected: list[Skip]
    problems: list[str]

    @property
    def ok(self) -> bool:
        return not self.problems


def lane_from_env(env: Mapping[str, str] = os.environ) -> Optional[str]:
    """The lane to enforce, or None when the guard is off."""
    value = env.get(LANE_ENV, "").strip()
    return value or None


def require_fixtures(env: Mapping[str, str] = os.environ) -> bool:
    return env.get(REQUIRE_FIXTURES_ENV, "").strip().lower() in _TRUTHY


def parse_allowlist(data: Mapping[str, Any]) -> Allowlist:
    """Build an :class:`Allowlist` from the JSON document, validating it.

    Every entry needs a ``reason`` regex that compiles and a non-empty ``why`` —
    an expected skip without a recorded justification is exactly what this
    guard exists to stop.
    """
    entries = []
    for index, raw in enumerate(data.get("allowed", [])):
        reason = raw.get("reason")
        why = (raw.get("why") or "").strip()
        if not reason or not why:
            raise ValueError(f"allowlist entry {index} needs both 'reason' and 'why': {raw}")
        re.compile(reason)
        nodeid = raw.get("nodeid")
        if nodeid is not None:
            re.compile(nodeid)
        lanes = raw.get("lanes") or ["*"]
        entries.append(AllowEntry(reason=reason, why=why, lanes=tuple(lanes), nodeid=nodeid))
    max_skips = {
        str(k): int(v)
        for k, v in (data.get("max_skips") or {}).items()
        if not str(k).startswith("_")  # "_comment" keys document the baseline
    }
    return Allowlist(entries=tuple(entries), max_skips=max_skips)


def load_allowlist(path: Path = ALLOWLIST_PATH) -> Allowlist:
    return parse_allowlist(json.loads(path.read_text(encoding="utf-8")))


def skip_reason(longrepr: Any) -> str:
    """The human reason out of a skipped report's ``longrepr``.

    A skip report carries ``(path, lineno, "Skipped: <reason>")``; anything else
    is stringified.
    """
    if isinstance(longrepr, tuple) and len(longrepr) == 3:
        text = str(longrepr[2])
    else:
        text = str(longrepr)
    return text[len("Skipped: ") :] if text.startswith("Skipped: ") else text


def evaluate(
    lane: str,
    *,
    collected: int,
    skips: Sequence[Skip],
    allowlist: Allowlist,
    require_fixtures: bool = False,
) -> Verdict:
    """Decide whether a run of ``lane`` is honest. Pure: no I/O, no env."""
    problems: list[str] = []
    allowed = allowlist.for_lane(lane)
    unexpected = [skip for skip in skips if not any(entry.matches(skip) for entry in allowed)]
    if collected == 0:
        problems.append("collected no tests: the lane ran nothing")
    # A skipped *module* (``pytest.skip(allow_module_level=True)``) has no
    # ``::`` in its node id and is not counted in ``collected``.
    elif sum("::" in skip.nodeid for skip in skips) >= collected:
        problems.append(f"all {collected} collected tests skipped: the lane ran nothing")
    if unexpected:
        problems.append(
            f"{len(unexpected)} skip(s) with a reason not allowlisted for lane '{lane}' "
            f"in {ALLOWLIST_PATH.name}"
        )
    if require_fixtures:
        missing = [skip for skip in skips if FIXTURE_UNAVAILABLE.search(skip.reason)]
        if missing:
            problems.append(
                f"{len(missing)} skip(s) on an unavailable fixture while "
                f"{REQUIRE_FIXTURES_ENV}=1"
            )
            for skip in missing:
                if skip not in unexpected:
                    unexpected.append(skip)
    limit = allowlist.max_skips.get(lane)
    if limit is not None and len(skips) > limit:
        problems.append(
            f"{len(skips)} skips exceed the committed baseline of {limit} for lane '{lane}' "
            f"(max_skips in {ALLOWLIST_PATH.name})"
        )
    return Verdict(
        lane=lane, collected=collected, skips=list(skips), unexpected=unexpected, problems=problems
    )


def fully_skipped_modules(skips: Iterable[Skip], ran: Iterable[str]) -> list[str]:
    """Test modules where nothing ran and at least one test skipped."""
    ran_modules = {nodeid.split("::", 1)[0] for nodeid in ran}
    skipped_modules = {skip.nodeid.split("::", 1)[0] for skip in skips}
    return sorted(skipped_modules - ran_modules)


def format_summary(
    skips: Sequence[Skip], *, fully_skipped: Sequence[str], verdict: Optional[Verdict]
) -> list[str]:
    """Lines for the terminal and the GitHub step summary: every skip grouped
    by reason, the fully-skipped modules, and the guard's verdict."""
    lines: list[str] = []
    by_reason: dict[str, list[str]] = {}
    for skip in skips:
        by_reason.setdefault(skip.reason, []).append(skip.nodeid)
    unexpected = {skip.nodeid for skip in verdict.unexpected} if verdict else set()
    lines.append(f"{len(skips)} skipped test(s), {len(by_reason)} distinct reason(s)")
    for reason, nodeids in sorted(by_reason.items(), key=lambda item: (-len(item[1]), item[0])):
        flag = " [UNEXPECTED]" if any(nodeid in unexpected for nodeid in nodeids) else ""
        lines.append(f"- ({len(nodeids)}){flag} {reason}")
        for nodeid in sorted(nodeids):
            lines.append(f"    {nodeid}")
    if fully_skipped:
        lines.append(f"fully skipped module(s): {', '.join(fully_skipped)}")
    if verdict is not None:
        if verdict.ok:
            lines.append(f"skip guard ({verdict.lane}): OK")
        else:
            lines.append(f"skip guard ({verdict.lane}): FAILED")
            for problem in verdict.problems:
                lines.append(f"  - {problem}")
            lines.append(
                "  Fix the fixture, or — only for a genuine environment gap — add an "
                f"entry with a 'why' to tests/system/{ALLOWLIST_PATH.name} (#4315)."
            )
    return lines
