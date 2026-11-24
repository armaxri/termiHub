"""Merge UI reviewers' findings into one deduped list (#5538).

Reads every ``<run>/review/findings/*.json`` (or the files given), validates
each against :mod:`.review_schema` — against the run's own surfaces and
screenshots when ``review-request.json`` exists — dedupes near-identical
findings, and writes::

    review/findings.json   the merged findings + what was rejected and why
    review/findings.md     a short maintainer summary, then every finding
    review/findings.js     the same JSON as window.__productRunReview(...) for the
                           progress page's "UI review" section (works from file://)
    review/grades.json     the grade per surface (#5817), with the previous
                           round's grade and the reviewer's verdicts on its findings
    review/history.json    surface -> grade per round across linked loop rounds,
                           plus the loop-stop decision of a loop round

Two findings are duplicates when they are about the same surface and kind and
their wording overlaps strongly (word-set Jaccard >= :data:`DUP_THRESHOLD`), or
when the text is the same. A merged finding keeps the most severe severity,
every screenshot and the ids it came from.
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from . import review_loop
from .recorder import _write_atomic
from .review_schema import SEVERITIES, VERDICTS, surface_review, validate_findings_file

DUP_THRESHOLD = 0.5
_STOP = frozenset(
    "the and for with that this from are was were not but its it's into onto than then "
    "when where which while also only very more less too has have had there their them "
    "should would could can will just one two any all".split()
)


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _words(text: str) -> frozenset[str]:
    return frozenset(w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2 and w not in _STOP)


def similarity(a: str, b: str) -> float:
    """Word-set Jaccard similarity of two finding texts (0..1)."""
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return 1.0 if a.strip().lower() == b.strip().lower() else 0.0
    return len(wa & wb) / len(wa | wb)


def is_duplicate(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if a["surface"] != b["surface"] or a["kind"] != b["kind"]:
        return False
    return similarity(a["finding"], b["finding"]) >= DUP_THRESHOLD


def _recommendation(item: dict[str, Any]) -> str:
    return item.get("recommendation") or item.get("suggestion") or ""


def dedupe(findings: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold duplicates together (input order wins ties); returns merged findings."""
    merged: list[dict[str, Any]] = []
    for item in findings:
        for into in merged:
            if is_duplicate(into, item):
                if SEVERITIES.index(item["severity"]) < SEVERITIES.index(into["severity"]):
                    into["severity"] = item["severity"]
                if item["screenshot"] not in into["screenshots"]:
                    into["screenshots"].append(item["screenshot"])
                into["sources"].append(item["source"])
                fix = _recommendation(item)
                if fix not in [into["recommendation"], *into["also_suggested"]]:
                    into["also_suggested"].append(fix)
                if not into["task"] and item.get("task"):
                    into["task"] = item["task"]
                break
        else:
            fix = _recommendation(item)
            merged.append(
                {
                    "surface": item["surface"],
                    "severity": item["severity"],
                    "kind": item["kind"],
                    "task": item.get("task") or "",
                    "finding": item["finding"],
                    "recommendation": fix,
                    "suggestion": fix,
                    "also_suggested": [],
                    "screenshots": [item["screenshot"]],
                    "sources": [item["source"]],
                }
            )
    merged.sort(key=lambda f: (SEVERITIES.index(f["severity"]), f["surface"]))
    for n, item in enumerate(merged, 1):
        item["id"] = f"R-{n:03d}"
    return merged


def _request_scope(review_dir: Path) -> tuple[Optional[list[str]], Optional[list[str]], dict]:
    try:
        request = json.loads((review_dir / "review-request.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, None, {}
    reviewers = request.get("reviewers") or []
    surfaces = [r["surface"] for r in reviewers]
    shots = [s["file"] for r in reviewers for s in r.get("shots", [])]
    return surfaces, shots, request


def load_findings(
    files: Iterable[Path],
    *,
    surfaces: Optional[list[str]] = None,
    screenshots: Optional[list[str]] = None,
    reviews: Optional[list[dict[str, Any]]] = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Valid findings (each with its ``source``) and the rejected entries of ``files``.

    ``reviews`` (when given) collects each readable file's surface-level part
    (:func:`.review_schema.surface_review`: grade, reason, verdicts) with its ``file``.
    """
    found, rejected = [], []
    for path in sorted(files):
        try:
            doc = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            rejected.append({"file": Path(path).name, "errors": [f"unreadable JSON: {exc}"]})
            continue
        valid, errors = validate_findings_file(doc, surfaces=surfaces, screenshots=screenshots)
        if errors:
            rejected.append({"file": Path(path).name, "errors": errors})
        found.extend({**f, "source": f"{Path(path).name}#{f['id']}"} for f in valid)
        if reviews is not None and isinstance(doc, dict):
            reviews.append({**surface_review(doc), "file": Path(path).name})
    return found, rejected


def merge_grades(
    reviews: Iterable[dict[str, Any]],
    findings: list[dict[str, Any]],
    *,
    surfaces: Optional[list[str]] = None,
    previous: Optional[dict[str, Optional[int]]] = None,
) -> dict[str, dict[str, Any]]:
    """surface -> its merged grade.

    Several graded files for one surface keep the lowest grade (the most
    critical reviewer wins) and every reason. ``surfaces`` (the reviewed ones)
    lists ungraded surfaces with ``grade: None`` and drops unknown ones;
    ``previous`` adds the previous round's grade and the change.
    """
    out: dict[str, dict[str, Any]] = {}
    for surface in surfaces or []:
        out[surface] = {"grade": None, "reasons": [], "reviewers": [], "files": [], "previous": []}
    for review in reviews:
        surface = review.get("surface")
        if not surface or (surfaces is not None and surface not in surfaces):
            continue
        entry = out.setdefault(
            surface, {"grade": None, "reasons": [], "reviewers": [], "files": [], "previous": []}
        )
        entry["files"].append(review["file"])
        if review.get("reviewer"):
            entry["reviewers"].append(review["reviewer"])
        if review.get("grade") is not None:
            entry["grade"] = (
                review["grade"] if entry["grade"] is None else min(entry["grade"], review["grade"])
            )
        if review.get("grade_reason"):
            entry["reasons"].append(review["grade_reason"])
        entry["previous"].extend(review.get("previous") or [])
    for surface, entry in out.items():
        entry["counts"] = _counts([f for f in findings if f["surface"] == surface])
        entry["verdicts"] = {
            v: sum(1 for p in entry["previous"] if p.get("verdict") == v) for v in VERDICTS
        }
        before = (previous or {}).get(surface)
        entry["previous_grade"] = before
        entry["change"] = (
            entry["grade"] - before if entry["grade"] is not None and before is not None else None
        )
    return dict(sorted(out.items()))


def _counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    return {sev: sum(1 for f in findings if f["severity"] == sev) for sev in SEVERITIES}


def _cell(grade: Optional[int]) -> str:
    return "-" if grade is None else str(grade)


def _grade_lines(doc: dict[str, Any]) -> list[str]:
    grades = doc.get("grades") or {}
    if not grades:
        return []
    history = doc.get("history") or {}
    lines = [
        "## Grades (1-5, usability first)",
        "",
        "| Surface | Grade | Previous | Trend | P1/P2/P3 | Previous findings | Reason |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for surface, g in grades.items():
        counts = "/".join(str(g["counts"].get(sev, 0)) for sev in SEVERITIES)
        verdicts = ", ".join(f"{n} {v}" for v, n in g["verdicts"].items() if n) or "-"
        steps = " → ".join(_cell(x) for x in review_loop.trend(history, surface)) or "-"
        reason = " ".join(g["reasons"]).replace("|", "/").replace("\n", " ") or "-"
        lines.append(
            f"| {surface} | {_cell(g['grade'])} | {_cell(g['previous_grade'])} | {steps} "
            f"| {counts} | {verdicts} | {reason} |"
        )
    lines.append("")
    loop = doc.get("loop")
    if loop:
        lines += [f"Loop round {loop['rounds_done']} of {loop['max_rounds']}: "
                  f"**{loop['action']}** — {loop['reason']}.", ""]
    return lines


def render_markdown(doc: dict[str, Any]) -> str:
    findings, counts = doc["findings"], doc["counts"]
    total = len(findings)
    surfaces = sorted({f["surface"] for f in findings})
    lines = [
        f"# UI review findings: product run {doc.get('run_id') or '?'}",
        "",
        f"{total} findings after dedupe ({doc['raw_count']} reported) — "
        + ", ".join(f"{n} {sev}" for sev, n in counts.items())
        + (f" — surfaces: {', '.join(surfaces)}" if surfaces else ""),
        "",
    ]
    lines += _grade_lines(doc)
    top = [f for f in findings if f["severity"] == "P1"][:5]
    if top:
        lines += ["Most important:", ""]
        lines += [f"- {f['id']} ({f['surface']}): {f['finding']}" for f in top]
        lines.append("")
    if doc["rejected"]:
        lines += ["Rejected reviewer output (not merged):", ""]
        for bad in doc["rejected"]:
            lines += [f"- `{bad['file']}`: {e}" for e in bad["errors"]]
        lines.append("")
    for f in findings:
        lines += [
            f"## {f['id']} {f['severity']} {f['kind']} — {f['surface']}",
            "",
            f["finding"],
            "",
            *([f"Task: {f['task']}", ""] if f.get("task") else []),
            f"Recommendation: {f['recommendation']}",
            *[f"Also suggested: {s}" for s in f["also_suggested"]],
            "",
            "Screenshots: " + ", ".join(f"`{s}`" for s in f["screenshots"]),
            "Sources: " + ", ".join(f["sources"]),
            "",
        ]
    return "\n".join(lines)


def _loop_decision(run_dir: Path, grades: dict[str, dict[str, Any]]) -> Optional[dict[str, Any]]:
    """The stop rule after this round, for a loop round (``None`` for a full run)."""
    info = review_loop.loop_info(run_dir)
    if not info.get("surfaces"):
        return None
    return review_loop.loop_decision(
        {s: g["grade"] for s, g in grades.items()},
        info["surfaces"],
        target_grade=int(info.get("target_grade") or review_loop.DEFAULT_TARGET_GRADE),
        rounds_done=review_loop.loop_round(run_dir),
        max_rounds=int(info.get("max_rounds") or review_loop.DEFAULT_MAX_ROUNDS),
    )


def merge_review(
    run_dir: Path,
    files: Optional[Iterable[Path]] = None,
    *,
    clock: Callable[[], str] = _now,
) -> dict[str, Any]:
    """Validate, dedupe and write the merged findings of one run (see the module docstring)."""
    review_dir = Path(run_dir).resolve() / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    surfaces, shots, request = _request_scope(review_dir)
    paths = list(files) if files is not None else sorted((review_dir / "findings").glob("*.json"))
    reviews: list[dict[str, Any]] = []
    found, rejected = load_findings(paths, surfaces=surfaces, screenshots=shots, reviews=reviews)
    merged = dedupe(found)
    run_dir = Path(run_dir).resolve()
    run_id = request.get("run_id") or run_dir.name
    previous = review_loop.previous_run(run_dir)
    grades = merge_grades(
        reviews,
        merged,
        surfaces=surfaces,
        previous=review_loop.read_grades(previous) if previous else None,
    )
    generated = clock()
    grades_doc = {"schema": 1, "run_id": run_id, "generated_at": generated,
                  "round": review_loop.loop_round(run_dir), "surfaces": grades}
    _write_atomic(review_dir / "grades.json", json.dumps(grades_doc, indent=2) + "\n")
    history = review_loop.build_history(run_dir)
    loop = _loop_decision(run_dir, grades)
    if loop:
        history["loop"] = loop
    _write_atomic(review_dir / "history.json", json.dumps(history, indent=2) + "\n")
    doc = {
        "schema": 1,
        "run_id": run_id,
        "generated_at": generated,
        "files": [Path(p).name for p in paths],
        "raw_count": len(found),
        "counts": _counts(merged),
        "findings": merged,
        "rejected": rejected,
        "grades": grades,
        "history": history,
        "loop": loop,
    }
    text = json.dumps(doc, indent=2)
    _write_atomic(review_dir / "findings.json", text + "\n")
    _write_atomic(review_dir / "findings.js", f"window.__productRunReview({text});\n")
    _write_atomic(review_dir / "findings.md", render_markdown(doc))
    return doc
