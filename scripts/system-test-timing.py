#!/usr/bin/env python3
"""Summarise observed system-test harness timings from CI logs (#3660, WA-CI-006).

The per-operation deadlines in ``tests/system/termihub_harness/deadlines.py`` are
sized from *observed* timings, not guessed. This script is how those timings are
collected: it downloads the job logs of recent ``system-integration.yml`` runs
(or reads already-downloaded logs) and prints markdown tables of

1. **Per-operation timings** from the ``[termihub-test-timing] {json}`` lines the
   harness prints at session end when ``TERMIHUB_TEST_TIMING=1`` (one line per
   operation per session: ``n``/``p50``/``p95``/``max``/``deadline``/``timeouts``).
   Across sessions it reports the median of the per-session p50s, the **largest**
   per-session p95 (conservative) and the overall max.
2. **Per-test phase durations** from pytest's ``--durations`` table — the coarse
   data every historical run already has (only the slowest N per job, so it is
   biased towards slow tests; treat it as an upper bound on the ops inside).
3. **Deadline hits** — how often each chokepoint actually timed out, counted from
   the ``E  …`` traceback lines (``no app connected …``, ``command timed out …``,
   ``timed out waiting for …``). Counted over *all* downloaded jobs, including
   failed ones, because a timeout is only ever visible in a failed attempt.

Usage (needs an authenticated ``gh`` CLI for the download step)::

    python scripts/system-test-timing.py                  # last 10 runs, successful jobs
    python scripts/system-test-timing.py --runs 30 --all-jobs
    python scripts/system-test-timing.py --log-dir DIR    # offline: parse DIR/*.log

Downloaded logs are cached in ``--cache-dir`` (default: a temp dir) so a re-run
with different filters does not re-download. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import subprocess
import sys
import tempfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

TIMING_TAG = "[termihub-test-timing]"
DEFAULT_REPO = "armaxri/termiHub"
DEFAULT_WORKFLOW = "system-integration.yml"

# A GitHub Actions log line starts with an ISO timestamp; strip it before parsing.
_GH_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?")
# pytest --durations row: "12.34s setup    tests/test_x.py::TestX::test_y".
_DURATION_ROW = re.compile(r"^(\d+(?:\.\d+)?)s (setup|call|teardown)\s+(\S+)")
_APP_CONNECT_TIMEOUT = re.compile(r"no app connected to the bridge within ([\d.]+)s")
_COMMAND_TIMEOUT = re.compile(r"command timed out after ([\d.]+)s")
_WAIT_TIMEOUT = re.compile(r"timed out waiting for (.+?)(?: \(last error: .*)?$")


def strip_gh_prefix(line: str) -> str:
    """Drop the GitHub Actions timestamp prefix (and a trailing CR) from a log line."""
    return _GH_TIMESTAMP.sub("", line.rstrip("\r\n"))


def normalize_label(label: str) -> str:
    """Collapse the dynamic parts of a wait label so call sites group together.

    ``timed out waiting for output 'mk-3f9a'`` and ``… 'mk-77c1'`` are the same
    operation; quoted strings become ``'…'`` and digit runs become ``N``.
    """
    label = re.sub(r"'[^']*'", "'…'", label)
    label = re.sub(r'"[^"]*"', '"…"', label)
    label = re.sub(r"\d+", "N", label)
    return label.strip()[:80]


def classify_os(name: str) -> str:
    """Map a job name (or runner label) to ``linux`` / ``macos`` / ``windows``."""
    lowered = name.lower()
    if "macos" in lowered or "darwin" in lowered:
        return "macos"
    if "windows" in lowered:
        return "windows"
    if "ubuntu" in lowered or "linux" in lowered:
        return "linux"
    return "unknown"


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile (``pct`` in 0..100) of a non-empty list."""
    ordered = sorted(values)
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]


# ── Parsing ──────────────────────────────────────────────────────────────────
def parse_timing_lines(text: str) -> list[dict]:
    """Every ``[termihub-test-timing] {json}`` record in a log. Non-JSON lines skip."""
    records = []
    for raw in text.splitlines():
        line = strip_gh_prefix(raw)
        index = line.find(TIMING_TAG)
        if index < 0:
            continue
        payload = line[index + len(TIMING_TAG) :].strip()
        if not payload.startswith("{"):
            continue  # the Rust agent tests emit free-text phase lines; not ours
        try:
            record = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict) and "op" in record and "max" in record:
            records.append(record)
    return records


def parse_durations(text: str) -> list[tuple[float, str, str]]:
    """``(seconds, phase, nodeid)`` rows from every ``slowest … durations`` table."""
    rows = []
    in_table = False
    for raw in text.splitlines():
        line = strip_gh_prefix(raw)
        if "slowest" in line and "durations" in line and line.startswith("="):
            in_table = True
            continue
        if not in_table:
            continue
        match = _DURATION_ROW.match(line)
        if match:
            rows.append((float(match.group(1)), match.group(2), match.group(3)))
        elif line.startswith("=") or (line and not line[0].isdigit()):
            in_table = False
    return rows


def parse_deadline_hits(text: str) -> list[tuple[str, float]]:
    """``(op, budget_seconds)`` for every harness deadline that fired in a log.

    Reads only the pytest ``E   …`` traceback lines, which carry the final
    exception message exactly once per failed attempt.
    """
    hits = []
    for raw in text.splitlines():
        line = strip_gh_prefix(raw)
        if not line.startswith("E "):
            continue
        message = line[1:].strip()
        match = _APP_CONNECT_TIMEOUT.search(message)
        if match:
            hits.append(("app-connect", float(match.group(1))))
            continue
        match = _COMMAND_TIMEOUT.search(message)
        if match:
            hits.append(("command", float(match.group(1))))
            continue
        if message.startswith("AssertionError: timed out waiting for"):
            match = _WAIT_TIMEOUT.search(message)
            if match:
                hits.append(("wait:" + normalize_label(match.group(1)), math.nan))
    return hits


# ── Aggregation ──────────────────────────────────────────────────────────────
@dataclass
class OpStats:
    """Cross-session aggregate of one operation's timing records on one OS."""

    sessions: int = 0
    n: int = 0
    timeouts: int = 0
    p50s: list = field(default_factory=list)
    p95s: list = field(default_factory=list)
    maxes: list = field(default_factory=list)
    deadlines: list = field(default_factory=list)

    def add(self, record: dict) -> None:
        self.sessions += 1
        self.n += int(record.get("n", 0))
        self.timeouts += int(record.get("timeouts", 0))
        self.p50s.append(float(record.get("p50", record["max"])))
        self.p95s.append(float(record.get("p95", record["max"])))
        self.maxes.append(float(record["max"]))
        if record.get("deadline") is not None:
            self.deadlines.append(float(record["deadline"]))

    def row(self) -> dict:
        return {
            "sessions": self.sessions,
            "n": self.n,
            "p50": statistics.median(self.p50s),
            "p95": max(self.p95s),
            "max": max(self.maxes),
            "deadline": max(self.deadlines) if self.deadlines else None,
            "timeouts": self.timeouts,
        }


def aggregate_timings(logs: Iterable[tuple[str, str]]) -> dict:
    """``{(os, op): OpStats}`` over ``(os, log_text)`` pairs."""
    table: dict = defaultdict(OpStats)
    for os_name, text in logs:
        for record in parse_timing_lines(text):
            table[(os_name, record["op"])].add(record)
    return dict(table)


def aggregate_durations(logs: Iterable[tuple[str, str]]) -> dict:
    """``{(os, phase): [seconds…]}`` over every ``--durations`` row."""
    table: dict = defaultdict(list)
    for os_name, text in logs:
        for seconds, phase, _nodeid in parse_durations(text):
            table[(os_name, phase)].append(seconds)
    return dict(table)


def aggregate_hits(logs: Iterable[tuple[str, str]]) -> dict:
    """``{(os, op): (count, max_budget)}`` over every deadline that fired."""
    table: dict = {}
    for os_name, text in logs:
        for op, budget in parse_deadline_hits(text):
            count, best = table.get((os_name, op), (0, math.nan))
            if not math.isnan(budget):
                best = budget if math.isnan(best) else max(best, budget)
            table[(os_name, op)] = (count + 1, best)
    return table


# ── Rendering ────────────────────────────────────────────────────────────────
def _fmt(value: Optional[float]) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "—"
    return f"{value:.2f}"


def render_markdown(timings: dict, durations: dict, hits: dict, jobs: int) -> str:
    out = [f"Parsed {jobs} job log(s).", ""]
    out.append("### Per-operation timings (`[termihub-test-timing]`)")
    out.append("")
    if timings:
        out.append("| OS | Operation | Sessions | Samples | p50 (s) | p95 (s) | max (s) | Deadline (s) | Timeouts |")
        out.append("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
        for (os_name, op), stats in sorted(timings.items()):
            r = stats.row()
            out.append(
                f"| {os_name} | `{op}` | {r['sessions']} | {r['n']} | {_fmt(r['p50'])} | "
                f"{_fmt(r['p95'])} | {_fmt(r['max'])} | {_fmt(r['deadline'])} | {r['timeouts']} |"
            )
    else:
        out.append("_No timing lines found — the runs predate the harness timing summary (#3660)._")
    out.append("")
    out.append("### Per-test phase durations (pytest `--durations`, slowest rows only)")
    out.append("")
    if durations:
        out.append("| OS | Phase | Rows | p50 (s) | p95 (s) | max (s) |")
        out.append("| --- | --- | ---: | ---: | ---: | ---: |")
        for (os_name, phase), values in sorted(durations.items()):
            out.append(
                f"| {os_name} | {phase} | {len(values)} | {_fmt(percentile(values, 50))} | "
                f"{_fmt(percentile(values, 95))} | {_fmt(max(values))} |"
            )
    else:
        out.append("_No `--durations` tables found._")
    out.append("")
    out.append("### Deadline hits (all parsed jobs)")
    out.append("")
    if hits:
        out.append("| OS | Operation | Hits | Budget (s) |")
        out.append("| --- | --- | ---: | ---: |")
        ordered = sorted(hits.items(), key=lambda kv: (kv[0][0], -kv[1][0], kv[0][1]))
        for (os_name, op), (count, budget) in ordered:
            out.append(f"| {os_name} | `{op}` | {count} | {_fmt(budget)} |")
    else:
        out.append("_No harness deadline fired._")
    out.append("")
    return "\n".join(out)


# ── Download ─────────────────────────────────────────────────────────────────
def _gh_json(args: list[str]):
    result = subprocess.run(["gh", *args], check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def download_logs(
    repo: str,
    workflow: str,
    runs: int,
    cache_dir: Path,
    *,
    all_jobs: bool,
    branch: Optional[str],
    scan_limit: int,
) -> list[tuple[str, Path]]:
    """Fetch job logs of the ``runs`` most recent runs with a qualifying job.

    A job qualifies when it concluded ``success`` (or, with ``all_jobs``, when it
    ran to a ``success``/``failure`` conclusion). Returns ``(os, path)`` pairs.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    list_args = [
        "run", "list", "--repo", repo, "--workflow", workflow,
        "--limit", str(scan_limit), "--json", "databaseId",
    ]
    if branch:
        list_args += ["--branch", branch]
    wanted = {"success", "failure"} if all_jobs else {"success"}
    picked: list[tuple[str, Path]] = []
    used_runs = 0
    for run in _gh_json(list_args):
        if used_runs >= runs:
            break
        run_id = run["databaseId"]
        jobs = _gh_json(["api", f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"])["jobs"]
        chosen = [j for j in jobs if j.get("conclusion") in wanted and j["name"] != "setup"]
        if not chosen:
            continue
        used_runs += 1
        for job in chosen:
            path = cache_dir / f"job_{job['id']}.log"
            if not path.exists() or path.stat().st_size == 0:
                log = subprocess.run(
                    ["gh", "api", f"repos/{repo}/actions/jobs/{job['id']}/logs"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                )
                if log.returncode != 0:
                    print(f"warning: no log for job {job['id']} (expired?)", file=sys.stderr)
                    continue
                path.write_text(log.stdout, encoding="utf-8")
            picked.append((classify_os(job["name"]), path))
    return picked


def detect_log_os(text: str) -> str:
    """The runner OS from a job log's ``##[group]Operating System`` header block."""
    lines = text[:20000].splitlines()
    for index, raw in enumerate(lines[:-1]):
        if strip_gh_prefix(raw).endswith("##[group]Operating System"):
            return classify_os(strip_gh_prefix(lines[index + 1]))
    return "unknown"


def _local_logs(log_dir: Path) -> list[tuple[str, Path]]:
    """``(os, path)`` for ``DIR/*.log``, the OS read from each log's header."""
    return [
        (detect_log_os(path.read_text(encoding="utf-8", errors="replace")), path)
        for path in sorted(log_dir.glob("*.log"))
    ]


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--workflow", default=DEFAULT_WORKFLOW)
    parser.add_argument("--branch", help="only runs of this head branch")
    parser.add_argument("--runs", type=int, default=10, help="runs with a qualifying job (default 10)")
    parser.add_argument("--scan-limit", type=int, default=200, help="how many recent runs to scan")
    parser.add_argument(
        "--all-jobs",
        action="store_true",
        help="also parse failed jobs (their passing ops and deadline hits are real data)",
    )
    parser.add_argument("--cache-dir", type=Path, help="where downloaded logs are kept")
    parser.add_argument("--log-dir", type=Path, help="parse DIR/*.log instead of downloading")
    args = parser.parse_args(argv)

    if args.log_dir:
        sources = _local_logs(args.log_dir)
    else:
        cache = args.cache_dir or Path(tempfile.mkdtemp(prefix="termihub-timing-"))
        sources = download_logs(
            args.repo,
            args.workflow,
            args.runs,
            cache,
            all_jobs=args.all_jobs,
            branch=args.branch,
            scan_limit=args.scan_limit,
        )
        print(f"logs cached in {cache}", file=sys.stderr)

    logs = [(os_name, path.read_text(encoding="utf-8", errors="replace")) for os_name, path in sources]
    print(
        render_markdown(
            aggregate_timings(logs),
            aggregate_durations(logs),
            aggregate_hits(logs),
            len(logs),
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
