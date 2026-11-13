"""Hand one product run to UI-expert reviewer agents (#5538).

:func:`prepare_review` turns a finished run directory into ``<run>/review/``::

    review/
      review-brief.md        product context + every surface: screenshot, expected
                             screen, the step's machine grade and evidence
      review-request.json    what the coordinator feeds to reviewer agents: one
                             entry per surface with a self-contained prompt, the
                             screenshot list and where the reviewer writes findings
      contact/<surface>.png  every screenshot of one surface on one sheet
      findings/              reviewers write <surface>.json here (schema:
                             review_schema.FINDING_JSON_SCHEMA)

Screenshots are grouped by *surface* (the second segment of the step id,
``checklist.<surface>.<detail>``, or an explicit ``surface`` in the manifest), so
one reviewer sees one family of screens. After the reviewers ran,
:mod:`.review_merge` validates, dedupes and renders their findings.

Plain file I/O, unit-tested in the normal lane (``tests/test_product_run_review.py``).
"""

from __future__ import annotations

import datetime
import json
from pathlib import Path
from typing import Any, Callable, Optional

from .recorder import _write_atomic, safe_step_id
from .review_images import contact_sheet_file
from .review_schema import (
    FINDING_FIELDS,
    FINDING_JSON_SCHEMA,
    KIND_MEANING,
    SEVERITY_MEANING,
)

REVIEW_SCHEMA = 1
REQUEST_KIND = "termihub-product-run-ui-review"
MERGE_COMMAND = "python3 scripts/internal/product-run-review.py merge {run_dir}"

PRODUCT_CONTEXT = (
    "termiHub is a cross-platform desktop terminal hub (Tauri 2 + React) for developers and "
    "embedded/ops engineers: local shells, SSH (jump hosts, keys, agents), serial, telnet, a "
    "remote agent, SFTP file browsing, port forwarding, RDP/VNC and monitoring, in a "
    "VS Code-inspired layout (activity bar, sidebar, tabs, split views, status bar). It is "
    "pre-release and held to a safety-critical quality bar: every screen must be unambiguous, "
    "readable in all four themes (Dark, Light, Solarized Dark, Solarized Light) and usable at "
    "the 800x600 minimum window size. Its design system: shared primitives (Button, Input, "
    "Field, Select, Modal, Toggle, Toast), tokens only, sentence-case labels, one primary "
    "action per footer."
)

LOOK_FOR = (
    "Looks: alignment and spacing, truncation and overflow (cut-off or wrapping text, clipped "
    "controls), contrast (WCAG 2.2: 4.5:1 text, 3:1 non-text), emphasis (is the most important "
    "thing the most prominent? one primary action?), density (cramped or wasted space), "
    "consistency with the rest of the app (heights, radii, icon sizes, casing).",
    "Usefulness: elements that do not earn their place (useless, redundant, decorative noise), "
    "wrong emphasis, missing affordances or feedback, confusing or inconsistent wording, and "
    "whether the screen actually serves what the step is about.",
)

NOT_FINDINGS = (
    "Harness artefacts are not findings: the clearly labelled seeded fake crash report, the "
    "'product-run' / 'question-shell' prompts and the seeded connection names, the test window "
    "being pinned on top, and a step whose screenshot shows its *failure* state (judge the "
    "screen, the grade is already recorded)."
)


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _read_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def surface_of(shot: dict[str, Any]) -> str:
    """The surface a screenshot belongs to (see the module docstring)."""
    explicit = shot.get("surface")
    if isinstance(explicit, str) and explicit.strip():
        return safe_step_id(explicit.strip())
    parts = [p for p in str(shot.get("step", "")).split(".") if p]
    if len(parts) >= 3:
        return safe_step_id(parts[1])
    return safe_step_id(parts[0]) if parts else "misc"


def surface_title(surface: str, shots: list[dict[str, Any]]) -> str:
    phases = sorted({str(s.get("phase") or "") for s in shots} - {""})
    name = surface.replace("-", " ").replace("_", " ")
    return f"{name[:1].upper()}{name[1:]}" + (f" ({', '.join(phases)})" if phases else "")


def _window(shot: dict[str, Any]) -> str:
    css = shot.get("window_css") or {}
    capture = f"{shot['width']}x{shot['height']} px" if shot.get("width") else "?"
    if css.get("width"):
        return f"{capture} capture, viewport {css.get('width')} x {css.get('height')}"
    return f"{capture} capture"


def _shot_entry(shot: dict[str, Any], step: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    return {
        "file": shot["file"],
        "path": str((run_dir / shot["file"]).resolve()),
        "step": shot.get("step"),
        "phase": shot.get("phase") or step.get("phase"),
        "label": shot.get("label"),
        "title": shot.get("title") or step.get("title"),
        "expect": shot.get("expect") or step.get("expect") or "",
        "status": step.get("status"),
        "reason": step.get("reason"),
        "evidence": list(step.get("evidence") or []),
        "theme": shot.get("theme"),
        "window": _window(shot),
        "source": shot.get("source"),
    }


def group_shots(run_dir: Path) -> dict[str, list[dict[str, Any]]]:
    """Screenshots of the run, grouped by surface in run order (with their step's grade)."""
    manifest = _read_json(run_dir / "shots" / "manifest.json") or {"shots": []}
    record = _read_json(run_dir / "results.json") or _read_json(run_dir / "status.json") or {}
    steps = {s["id"]: s for s in record.get("steps", []) if isinstance(s, dict) and "id" in s}
    groups: dict[str, list[dict[str, Any]]] = {}
    for shot in manifest.get("shots", []):
        if not isinstance(shot, dict) or not shot.get("file"):
            continue
        if not (run_dir / shot["file"]).is_file():
            continue
        entry = _shot_entry(shot, steps.get(shot.get("step"), {}), run_dir)
        groups.setdefault(surface_of(shot), []).append(entry)
    return groups


def _schema_lines() -> list[str]:
    lines = [f"- `{name}`: {desc}" for name, (desc, _allowed) in FINDING_FIELDS.items()]
    lines += [f"- severity {k}: {v}" for k, v in SEVERITY_MEANING.items()]
    lines += [f"- kind `{k}`: {v}" for k, v in KIND_MEANING.items()]
    return lines


def _shot_lines(shots: list[dict[str, Any]], *, absolute: bool) -> list[str]:
    lines = []
    for n, s in enumerate(shots, 1):
        label = f" [{s['label']}]" if s.get("label") else ""
        lines.append(f"{n}. `{s['path'] if absolute else s['file']}`{label} - step `{s['step']}`")
        lines.append(f"   - should show: {s['expect'] or s['title'] or '(not stated)'}")
        lines.append(f"   - theme {s['theme'] or '?'}, window {s['window']}, source {s['source']}")
        grade = f"{s['status']}" + (f" ({s['reason']})" if s.get("reason") else "")
        lines.append(f"   - machine grade: {grade}")
        for ev in s["evidence"][:6]:
            lines.append(f"     - {ev}")
    return lines


def reviewer_prompt(
    *, surface: str, title: str, shots: list[dict[str, Any]], contact: Optional[str], output: str
) -> str:
    """The self-contained brief one reviewer agent gets for one surface."""
    lines = [
        f"You are a senior UI/UX expert reviewing the '{title}' surface of termiHub from "
        "screenshots of an automated product run. Analyse looks AND usefulness; the maintainer "
        "will not look at the screens, your review replaces that.",
        "",
        "Product: " + PRODUCT_CONTEXT,
        "",
        "Look for:",
        *[f"- {item}" for item in LOOK_FOR],
        "",
        NOT_FINDINGS,
        "",
        "Screens (open every file with the Read tool; they are PNGs):",
        *(
            [f"- contact sheet of all of them, in this order: `{contact}`"] if contact else []
        ),
        *_shot_lines(shots, absolute=True),
        "",
        "Rules: read-only — do not edit any file except your output, do not file issues, do not "
        "run the app. Report only what you can see on these screenshots; at most 12 findings, "
        "most severe first; merge near-duplicates yourself. An empty list is a valid answer.",
        "",
        f"Write your result as JSON to `{output}`:",
        f'{{"surface": "{surface}", "reviewer": "ui-review-{surface}", "findings": [ ... ]}}',
        "Each finding has exactly these string fields (all required):",
        *_schema_lines(),
        f"`surface` must be \"{surface}\"; `screenshot` is the run-relative path (`shots/...`) "
        "shown in backticks above minus the run directory.",
        "Finish by replying with the number of findings per severity.",
    ]
    return "\n".join(lines) + "\n"


def _brief(run: dict[str, Any], surfaces: list[dict[str, Any]], review_dir: Path) -> str:
    counts = ", ".join(f"{n} {k}" for k, n in (run.get("summary") or {}).items() if n)
    lines = [
        f"# UI review brief: product run {run.get('run_id', '?')}",
        "",
        f"Run state {run.get('state', '?')} ({counts or 'no steps'}). "
        f"Generated {run.get('generated_at')}.",
        "",
        "## Product",
        "",
        PRODUCT_CONTEXT,
        "",
        "## What to review",
        "",
        *[f"- {item}" for item in LOOK_FOR],
        f"- {NOT_FINDINGS}",
        "",
        "## Findings schema",
        "",
        *_schema_lines(),
        "",
        "## Surfaces",
    ]
    for entry in surfaces:
        lines += [
            "",
            f"### {entry['title']} (`{entry['surface']}`, {len(entry['shots'])} screenshot(s))",
            "",
        ]
        if entry["contact_sheet"]:
            lines += [f"Contact sheet: `{entry['contact_sheet']}`", ""]
        lines += _shot_lines(entry["shots"], absolute=False)
        lines += ["", f"Findings go to `{entry['output']}`."]
    lines += [
        "",
        "## After the review",
        "",
        "`" + MERGE_COMMAND.format(run_dir=review_dir.parent) + "`",
        "",
    ]
    return "\n".join(lines)


def prepare_review(
    run_dir: Path, *, contact_sheets: bool = True, clock: Callable[[], str] = _now
) -> dict[str, Any]:
    """Write ``<run>/review/`` (see the module docstring); returns the request."""
    run_dir = Path(run_dir).resolve()
    record = _read_json(run_dir / "results.json") or _read_json(run_dir / "status.json")
    if record is None:
        raise FileNotFoundError(f"no product run at {run_dir} (no results.json / status.json)")
    review_dir = run_dir / "review"
    (review_dir / "findings").mkdir(parents=True, exist_ok=True)
    surfaces = []
    for surface, shots in group_shots(run_dir).items():
        title = surface_title(surface, shots)
        contact, skipped = None, []
        if contact_sheets:
            sheet = review_dir / "contact" / f"{surface}.png"
            skipped = contact_sheet_file([Path(s["path"]) for s in shots], sheet)
            contact = sheet.relative_to(run_dir).as_posix() if sheet.is_file() else None
        output = review_dir / "findings" / f"{surface}.json"
        surfaces.append(
            {
                "id": f"ui-review-{surface}",
                "surface": surface,
                "title": title,
                "themes": sorted({s["theme"] for s in shots if s.get("theme")}),
                "windows": sorted({s["window"] for s in shots}),
                "contact_sheet": contact,
                "contact_sheet_skipped": skipped,
                "output": output.relative_to(run_dir).as_posix(),
                "shots": shots,
                "prompt": reviewer_prompt(
                    surface=surface,
                    title=title,
                    shots=shots,
                    contact=str(run_dir / contact) if contact else None,
                    output=str(output),
                ),
            }
        )
    generated = clock()
    request = {
        "schema": REVIEW_SCHEMA,
        "kind": REQUEST_KIND,
        "run_id": record.get("run_id"),
        "run_dir": str(run_dir),
        "run_state": record.get("state"),
        "summary": record.get("summary") or {},
        "generated_at": generated,
        "product_context": PRODUCT_CONTEXT,
        "how_to": {
            "spawn": "one read-only reviewer agent per entry of `reviewers`, prompt = its "
            "`prompt`; each writes its `output` file (run-relative)",
            "merge": MERGE_COMMAND.format(run_dir=run_dir),
        },
        "finding_schema": FINDING_JSON_SCHEMA,
        "reviewers": surfaces,
    }
    _write_atomic(review_dir / "review-request.json", json.dumps(request, indent=2) + "\n")
    brief = _brief({**record, "generated_at": generated}, surfaces, review_dir)
    _write_atomic(review_dir / "review-brief.md", brief)
    return request
