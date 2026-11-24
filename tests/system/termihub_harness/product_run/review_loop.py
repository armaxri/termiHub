"""The graded UI-review loop across linked product runs (#5817).

A full product run is round 0. When its merged review leaves surfaces below the
target grade, ``scripts/internal/product-run.sh --loop <surface>[,...]`` re-runs
only the tests behind those surfaces into a new run directory that links back::

    <new run>/
      loop.json              round, looped surfaces, target grade, max rounds,
                             the pytest node ids that were selected
      run-info.json          the commit the run was made from (the runner writes it)
      review/previous-run    the previous run's directory (one line)
      review/grades.json     this round's grade per surface (written by merge)
      review/history.json    surface -> grade per round across the linked chain

:func:`plan_loop` decides the next round (:func:`loop_decision` is the stop
rule) and selects the steps behind the surfaces; :func:`loop_context` is what
:mod:`.review` puts into the next review request (the previous round's findings
and grade, the grade trend and the PRs that touched each surface since the
previous run). The tooling only prepares: the coordinator spawns the reviewers.

Plain file I/O plus ``git log``; unit-tested in the normal lane
(``tests/test_product_run_review_loop.py``).
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from .recorder import _write_atomic, safe_step_id

LOOP_FILE = "loop.json"
RUN_INFO_FILE = "run-info.json"
PREVIOUS_LINK = Path("review") / "previous-run"
GRADES_FILE = Path("review") / "grades.json"
HISTORY_FILE = Path("review") / "history.json"
FINDINGS_FILE = Path("review") / "findings.json"

DEFAULT_TARGET_GRADE = 4
DEFAULT_MAX_ROUNDS = 3
#: ``loop_decision`` actions.
CONTINUE, DONE, ESCALATE, NEEDS_GRADES = "continue", "done", "escalate", "needs-grades"
#: Test files a product-run step can live in (relative to tests/system).
TEST_GLOB = "tests/test_product_run*.py"
MAX_CHAIN = 50
MAX_FILES = 40
_STEP_METHODS = frozenset({"step", "not_tested"})


def _read_json(path: Path) -> Optional[Any]:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# ── linking runs ──────────────────────────────────────────────────────────────
def previous_run(run_dir: Path) -> Optional[Path]:
    """The run this one was looped from, or ``None``."""
    try:
        text = (Path(run_dir) / PREVIOUS_LINK).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not text:
        return None
    path = Path(text)
    if not path.is_absolute():
        path = (Path(run_dir) / path).resolve()
    return path if path.is_dir() else None


def chain(run_dir: Path) -> list[Path]:
    """The linked runs, oldest (round 0) first, ending with ``run_dir``."""
    runs, seen = [], set()
    current: Optional[Path] = Path(run_dir).resolve()
    while current is not None and current not in seen and len(runs) < MAX_CHAIN:
        seen.add(current)
        runs.append(current)
        current = previous_run(current)
    return list(reversed(runs))


def loop_info(run_dir: Path) -> dict[str, Any]:
    doc = _read_json(Path(run_dir) / LOOP_FILE)
    return doc if isinstance(doc, dict) else {}


def loop_round(run_dir: Path) -> int:
    """0 for a full run, n for the n-th loop round."""
    value = loop_info(run_dir).get("round")
    return value if isinstance(value, int) and value > 0 else 0


def run_commit(run_dir: Path) -> Optional[str]:
    doc = _read_json(Path(run_dir) / RUN_INFO_FILE)
    commit = doc.get("commit") if isinstance(doc, dict) else None
    return commit if isinstance(commit, str) and commit.strip() else None


def read_grades(run_dir: Path) -> dict[str, Optional[int]]:
    """surface -> grade of one run's merged review (``{}`` before merge)."""
    doc = _read_json(Path(run_dir) / GRADES_FILE)
    surfaces = doc.get("surfaces") if isinstance(doc, dict) else None
    if not isinstance(surfaces, dict):
        return {}
    return {
        s: (v.get("grade") if isinstance(v, dict) and isinstance(v.get("grade"), int) else None)
        for s, v in surfaces.items()
    }


def read_findings(run_dir: Path, surface: Optional[str] = None) -> list[dict[str, Any]]:
    doc = _read_json(Path(run_dir) / FINDINGS_FILE)
    findings = doc.get("findings") if isinstance(doc, dict) else None
    if not isinstance(findings, list):
        return []
    return [f for f in findings if isinstance(f, dict) and surface in (None, f.get("surface"))]


# ── history + stop rule ───────────────────────────────────────────────────────
def build_history(run_dir: Path) -> dict[str, Any]:
    """surface -> grade per round across the chain ending at ``run_dir``."""
    rounds, surfaces = [], {}
    for index, run in enumerate(chain(run_dir)):
        grades = read_grades(run)
        rounds.append(
            {
                "round": index,
                "run_id": run.name,
                "run_dir": str(run),
                "commit": run_commit(run),
                "looped": list(loop_info(run).get("surfaces") or []),
            }
        )
        for surface, grade in grades.items():
            surfaces.setdefault(surface, []).append(
                {"round": index, "run_id": run.name, "grade": grade}
            )
    return {"schema": 1, "run_id": Path(run_dir).name, "rounds": rounds, "surfaces": surfaces}


def trend(history: dict[str, Any], surface: str) -> list[Optional[int]]:
    return [entry.get("grade") for entry in (history.get("surfaces") or {}).get(surface, [])]


def loop_decision(
    grades: dict[str, Optional[int]],
    surfaces: Iterable[str],
    *,
    target_grade: int = DEFAULT_TARGET_GRADE,
    rounds_done: int = 0,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
) -> dict[str, Any]:
    """The loop-stop rule for ``surfaces`` after a merged round.

    * ``needs-grades``: a surface has no grade yet (merge the reviewers first);
    * ``done``: every surface reached ``target_grade``;
    * ``escalate``: some are still below it but ``max_rounds`` loop rounds ran;
    * ``continue``: loop again, with only the surfaces still below the target.
    """
    surfaces = list(dict.fromkeys(surfaces))
    ungraded = [s for s in surfaces if grades.get(s) is None]
    below = [s for s in surfaces if grades.get(s) is not None and grades[s] < target_grade]
    reached = [s for s in surfaces if s not in ungraded and s not in below]
    if ungraded:
        action = NEEDS_GRADES
        why = f"no merged grade yet for {', '.join(ungraded)}"
    elif not below:
        action = DONE
        why = f"every surface reached grade {target_grade}"
    elif rounds_done >= max_rounds:
        action = ESCALATE
        why = f"{', '.join(below)} still below grade {target_grade} after {rounds_done} round(s)"
    else:
        action = CONTINUE
        why = f"{', '.join(below)} below grade {target_grade}; round {rounds_done + 1} of {max_rounds}"
    return {
        "action": action,
        "reason": why,
        "target_grade": target_grade,
        "rounds_done": rounds_done,
        "max_rounds": max_rounds,
        "below": below,
        "reached": reached,
        "ungraded": ungraded,
        "grades": {s: grades.get(s) for s in surfaces},
    }


# ── surface -> steps -> pytest nodes ──────────────────────────────────────────
def _surface_of_step(step_id: str) -> str:
    parts = [p for p in step_id.split(".") if p]
    if len(parts) >= 3:
        return safe_step_id(parts[1])
    return safe_step_id(parts[0]) if parts else "misc"


def surface_steps(run_dir: Path, surfaces: Iterable[str]) -> dict[str, list[str]]:
    """surface -> the step ids behind it in ``run_dir``, in run order.

    A step belongs to a surface when one of its screenshots does (the review's
    grouping, :func:`.review.surface_of`) or, without screenshots, by its id.
    """
    from .review import surface_of  # noqa: PLC0415 - review imports this module

    wanted = list(dict.fromkeys(surfaces))
    record = _read_json(Path(run_dir) / "results.json") or _read_json(Path(run_dir) / "status.json")
    manifest = _read_json(Path(run_dir) / "shots" / "manifest.json") or {}
    order = [s["id"] for s in (record or {}).get("steps", []) if isinstance(s, dict) and "id" in s]
    of_step: dict[str, set[str]] = {}
    for shot in manifest.get("shots", []) if isinstance(manifest, dict) else []:
        if isinstance(shot, dict) and shot.get("step"):
            of_step.setdefault(shot["step"], set()).add(surface_of(shot))
    for step in order:
        of_step.setdefault(step, {_surface_of_step(step)})
    ranked = order + sorted(set(of_step) - set(order))
    return {s: [step for step in ranked if s in of_step.get(step, set())] for s in wanted}


def scan_test_steps(system_dir: Path) -> tuple[dict[str, str], dict[str, list[str]]]:
    """From the product-run test sources: step id -> pytest node id, and node id ->
    the step ids its ``self.require(...)`` calls need (literal ids only)."""
    step_node, requires, _order = _scan(system_dir)
    return step_node, requires


def _scan(system_dir: Path) -> tuple[dict[str, str], dict[str, list[str]], dict[str, int]]:
    step_node: dict[str, str] = {}
    requires: dict[str, list[str]] = {}
    source_order: dict[str, int] = {}
    for path in sorted(Path(system_dir).glob(TEST_GLOB)):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        rel = path.relative_to(system_dir).as_posix()
        for cls in (n for n in tree.body if isinstance(n, ast.ClassDef)):
            for fn in cls.body:
                if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if not fn.name.startswith("test"):
                    continue
                node = f"{rel}::{cls.name}::{fn.name}"
                source_order.setdefault(node, len(source_order))
                for call in (c for c in ast.walk(fn) if isinstance(c, ast.Call)):
                    func = call.func
                    if not isinstance(func, ast.Attribute):
                        continue
                    literals = [
                        a.value
                        for a in call.args
                        if isinstance(a, ast.Constant) and isinstance(a.value, str)
                    ]
                    if func.attr in _STEP_METHODS and call.args and literals[:1] == [
                        getattr(call.args[0], "value", None)
                    ]:
                        step_node.setdefault(literals[0], node)
                    elif func.attr == "require":
                        requires.setdefault(node, []).extend(literals)
    return step_node, requires, source_order


def _node_of_record(step: dict[str, Any]) -> Optional[str]:
    node = step.get("node")
    return node if isinstance(node, str) and "::" in node else None


def select_nodes(
    run_dir: Path, step_ids: Iterable[str], system_dir: Path
) -> tuple[list[str], list[str]]:
    """The pytest node ids that re-run ``step_ids`` (plus the tests holding the
    steps they ``require``); and the steps no node was found for.

    Files keep the run's order; inside a file the tests keep their source
    order, so a required test runs before the one that needs it.

    The node a step ran in is recorded with the step (``node``); for older runs
    the test sources are scanned for the literal step id.
    """
    record = _read_json(Path(run_dir) / "results.json") or _read_json(Path(run_dir) / "status.json")
    steps = [s for s in (record or {}).get("steps", []) if isinstance(s, dict) and "id" in s]
    recorded = {s["id"]: _node_of_record(s) for s in steps}
    scanned, requires, source_order = _scan(system_dir)
    order = {s["id"]: n for n, s in enumerate(steps)}

    def node_of(step_id: str) -> Optional[str]:
        return recorded.get(step_id) or scanned.get(step_id)

    nodes: dict[str, int] = {}
    unresolved: list[str] = []
    pending = list(dict.fromkeys(step_ids))
    seen: set[str] = set()
    while pending:
        step_id = pending.pop(0)
        if step_id in seen:
            continue
        seen.add(step_id)
        node = node_of(step_id)
        if node is None:
            unresolved.append(step_id)
            continue
        rank = order.get(step_id, len(order))
        nodes[node] = min(rank, nodes.get(node, rank))
        pending.extend(r for r in requires.get(node, []) if r not in seen)
    file_rank: dict[str, int] = {}
    for node, rank in nodes.items():
        path = node.split("::", 1)[0]
        file_rank[path] = min(rank, file_rank.get(path, rank))

    def key(node: str) -> tuple[int, int, int, str]:
        path = node.split("::", 1)[0]
        return (file_rank[path], source_order.get(node, len(source_order)), nodes[node], node)

    return sorted(nodes, key=key), unresolved


# ── surface -> files -> PRs ───────────────────────────────────────────────────
def _git(repo: Path, *args: str) -> Optional[str]:
    try:
        done = subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, text=True, timeout=30
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _token(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def surface_files(
    repo: Path,
    surface: str,
    nodes: Iterable[str],
    *,
    git: Callable[..., Optional[str]] = _git,
) -> list[str]:
    """Best effort: the repo files behind a surface — the product-run test files
    its steps live in, and the app sources whose file name contains the surface
    name (``chooser`` -> ``CredentialChooser.tsx``)."""
    files = [f"tests/system/{n.split('::', 1)[0]}" for n in nodes]
    token = _token(surface)
    if len(token) >= 4:
        listed = git(repo, "ls-files", "--", "src", "src-tauri/src", "core/src") or ""
        for path in listed.splitlines():
            name = path.rsplit("/", 1)[-1]
            if token in _token(name.rsplit(".", 1)[0]) and ".test." not in name:
                files.append(path)
    return list(dict.fromkeys(files))[:MAX_FILES]


_MERGE_PR = re.compile(r"^Merge pull request #(\d+)")
_PAREN_PR = re.compile(r"\(#(\d+)\)\s*$")


def touched_prs(
    repo: Path,
    base: Optional[str],
    head: Optional[str],
    files: Iterable[str],
    *,
    git: Callable[..., Optional[str]] = _git,
) -> list[dict[str, Any]]:
    """PRs merged between two commits that changed ``files`` (best effort).

    Reads ``git log --first-parent -m base..head -- files``: a PR merge commit
    ("Merge pull request #N ...") or a subject ending in "(#N)" names the PR. A
    direct commit without a PR number is listed with ``pr: None``.
    """
    files = list(files)
    if not base or not head or not files or base == head:
        return []
    out = git(
        repo, "log", "--first-parent", "-m", "--format=%H%x1f%s", f"{base}..{head}", "--", *files
    )
    if out is None:
        return []
    prs: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line in out.splitlines():
        if "\x1f" not in line:
            continue
        sha, subject = line.split("\x1f", 1)
        if sha in seen:
            continue
        seen.add(sha)
        match = _MERGE_PR.match(subject) or _PAREN_PR.search(subject)
        prs.append({"pr": int(match.group(1)) if match else None, "commit": sha, "subject": subject})
    return prs


# ── planning a round ──────────────────────────────────────────────────────────
class LoopError(ValueError):
    """A loop round cannot be planned (unknown surface, no steps ...)."""


def plan_loop(
    previous: Path,
    surfaces: Iterable[str],
    *,
    system_dir: Path,
    target_grade: int = DEFAULT_TARGET_GRADE,
    max_rounds: int = DEFAULT_MAX_ROUNDS,
) -> dict[str, Any]:
    """Decide the next loop round after ``previous`` and select its pytest nodes.

    ``decision.action`` is the stop rule (:func:`loop_decision`); only for
    ``continue`` are ``surfaces`` / ``nodes`` filled (with the surfaces still
    below the target). Raises :class:`LoopError` for a surface the previous run
    has no step for, or when no test can be found for the selected steps.
    """
    previous = Path(previous).resolve()
    requested = [safe_step_id(s.strip()) for s in surfaces if s.strip()]
    if not requested:
        raise LoopError("no surface given")
    if not 1 <= target_grade <= 5:
        raise LoopError(f"target grade {target_grade} is not 1..5")
    if max_rounds < 1:
        raise LoopError(f"max rounds {max_rounds} must be at least 1")
    steps = surface_steps(previous, requested)
    unknown = [s for s, ids in steps.items() if not ids]
    if unknown:
        raise LoopError(f"the run {previous.name} has no step for surface(s) {', '.join(unknown)}")
    rounds_done = loop_round(previous)
    decision = loop_decision(
        read_grades(previous),
        requested,
        target_grade=target_grade,
        rounds_done=rounds_done,
        max_rounds=max_rounds,
    )
    plan: dict[str, Any] = {
        "schema": 1,
        "previous_run": str(previous),
        "previous_run_id": previous.name,
        "requested": requested,
        "round": rounds_done + 1,
        "target_grade": target_grade,
        "max_rounds": max_rounds,
        "decision": decision,
        "surfaces": [],
        "steps": {},
        "nodes": [],
        "unresolved_steps": [],
    }
    if decision["action"] != CONTINUE:
        return plan
    chosen = decision["below"]
    wanted = [step for s in chosen for step in steps[s]]
    nodes, unresolved = select_nodes(previous, wanted, system_dir)
    if not nodes:
        raise LoopError(f"no test found for the steps of {', '.join(chosen)}")
    plan.update(
        surfaces=chosen,
        steps={s: steps[s] for s in chosen},
        nodes=nodes,
        unresolved_steps=unresolved,
    )
    return plan


def init_loop_run(run_dir: Path, plan: dict[str, Any]) -> None:
    """Write ``loop.json`` and ``review/previous-run`` into a new loop round's dir."""
    run_dir = Path(run_dir)
    keys = ("round", "previous_run", "previous_run_id", "surfaces", "target_grade", "max_rounds",
            "steps", "nodes", "unresolved_steps")
    _write_atomic(run_dir / LOOP_FILE, json.dumps({"schema": 1, **{k: plan[k] for k in keys}},
                                                  indent=2) + "\n")
    _write_atomic(run_dir / PREVIOUS_LINK, plan["previous_run"] + "\n")


def loop_context(run_dir: Path, *, repo: Path, git: Callable[..., Optional[str]] = _git
                 ) -> Optional[dict[str, Any]]:
    """What a loop round's review request carries per looped surface; ``None``
    for a run that is not linked to a previous one."""
    run_dir = Path(run_dir).resolve()
    previous = previous_run(run_dir)
    if previous is None:
        return None
    info = loop_info(run_dir)
    history = build_history(previous)
    prev_grades = read_grades(previous)
    base, head = run_commit(previous), run_commit(run_dir)
    surfaces = list(info.get("surfaces") or [])
    nodes = list(info.get("nodes") or [])
    per_surface = {}
    for surface in surfaces:
        steps = (info.get("steps") or {}).get(surface) or []
        own_nodes, _ = select_nodes(run_dir, steps, repo / "tests" / "system") if steps else (
            nodes, [])
        files = surface_files(repo, surface, own_nodes or nodes, git=git)
        per_surface[surface] = {
            "previous_grade": prev_grades.get(surface),
            "trend": trend(history, surface),
            "previous_findings": read_findings(previous, surface),
            "files": files,
            "touched_prs": touched_prs(repo, base, head, files, git=git),
        }
    return {
        "round": loop_round(run_dir),
        "previous_run": str(previous),
        "previous_run_id": previous.name,
        "target_grade": info.get("target_grade", DEFAULT_TARGET_GRADE),
        "max_rounds": info.get("max_rounds", DEFAULT_MAX_ROUNDS),
        "commits": {"previous": base, "this": head},
        "surfaces": surfaces,
        "per_surface": per_surface,
    }
