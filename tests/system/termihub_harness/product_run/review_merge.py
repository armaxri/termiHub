"""Merge UI reviewers' findings into one deduped list (#5538).

Reads every ``<run>/review/findings/*.json`` (or the files given), validates
each against :mod:`.review_schema` — against the run's own surfaces and
screenshots when ``review-request.json`` exists — dedupes near-identical
findings, and writes::

    review/findings.json   the merged findings + what was rejected and why
    review/findings.md     a short maintainer summary, then every finding
    review/findings.js     the same JSON as window.__productRunReview(...) for the
                           progress page's "UI review" section (works from file://)

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

from .recorder import _write_atomic
from .review_schema import SEVERITIES, validate_findings_file

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
                if item["suggestion"] not in [into["suggestion"], *into["also_suggested"]]:
                    into["also_suggested"].append(item["suggestion"])
                break
        else:
            merged.append(
                {
                    "surface": item["surface"],
                    "severity": item["severity"],
                    "kind": item["kind"],
                    "finding": item["finding"],
                    "suggestion": item["suggestion"],
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
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Valid findings (each with its ``source``) and the rejected entries of ``files``."""
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
    return found, rejected


def _counts(findings: list[dict[str, Any]]) -> dict[str, int]:
    return {sev: sum(1 for f in findings if f["severity"] == sev) for sev in SEVERITIES}


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
            f"Suggestion: {f['suggestion']}",
            *[f"Also suggested: {s}" for s in f["also_suggested"]],
            "",
            "Screenshots: " + ", ".join(f"`{s}`" for s in f["screenshots"]),
            "Sources: " + ", ".join(f["sources"]),
            "",
        ]
    return "\n".join(lines)


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
    found, rejected = load_findings(paths, surfaces=surfaces, screenshots=shots)
    merged = dedupe(found)
    doc = {
        "schema": 1,
        "run_id": request.get("run_id") or Path(run_dir).name,
        "generated_at": clock(),
        "files": [Path(p).name for p in paths],
        "raw_count": len(found),
        "counts": _counts(merged),
        "findings": merged,
        "rejected": rejected,
    }
    text = json.dumps(doc, indent=2)
    _write_atomic(review_dir / "findings.json", text + "\n")
    _write_atomic(review_dir / "findings.js", f"window.__productRunReview({text});\n")
    _write_atomic(review_dir / "findings.md", render_markdown(doc))
    return doc
