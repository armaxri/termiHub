"""The UI-review finding schema — defined once, here (#5538).

A reviewer agent writes one JSON file per surface::

    {"surface": "chooser", "reviewer": "ui-review-chooser",
     "findings": [{"id": "chooser-1", "surface": "chooser",
                   "screenshot": "shots/checklist.chooser.recommended.png",
                   "severity": "P2", "kind": "looks",
                   "finding": "The hint wraps to three lines at 1280 px ...",
                   "suggestion": "Shorten it to ..."}]}

:data:`FINDING_FIELDS` is the single definition. :data:`FINDING_JSON_SCHEMA` (a
JSON Schema rendered from it) goes into ``review-request.json`` so reviewers see
the exact contract, and :func:`validate_finding` / :func:`validate_findings_file`
check reviewer output against the same fields before anything is merged.
"""

from __future__ import annotations

from typing import Any, Iterable, Optional

SEVERITIES = ("P1", "P2", "P3")
KINDS = ("looks", "usefulness", "bug")
#: What each severity means for the reviewer (also in the brief).
SEVERITY_MEANING = {
    "P1": "wrong or blocking: a user misreads the screen, cannot act, or text is unreadable",
    "P2": "clearly worse than it should be: noticeable on first look, worth fixing soon",
    "P3": "polish: small inconsistency or nicety",
}
KIND_MEANING = {
    "looks": "visual design: alignment, spacing, truncation, overflow, contrast, emphasis, density",
    "usefulness": "does the element earn its place: useless, redundant, missing or misleading",
    "bug": "the screen is not what the step expects (wrong state, broken layout, missing text)",
}
MAX_TEXT = 1200

#: name -> (description, allowed values or None). Every field is a required string.
FINDING_FIELDS: dict[str, tuple[str, Optional[tuple[str, ...]]]] = {
    "id": ("reviewer-local id, unique in its file, e.g. 'chooser-1'", None),
    "surface": ("the surface id from the review request", None),
    "screenshot": ("run-relative path of the screenshot it is seen on, e.g. 'shots/x.png'", None),
    "severity": ("P1 (worst) .. P3", SEVERITIES),
    "kind": ("looks | usefulness | bug", KINDS),
    "finding": ("what is wrong, concretely: where on the screen and why it matters", None),
    "suggestion": ("the concrete change that would fix it", None),
}

FINDING_JSON_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "termiHub product-run UI review findings",
    "type": "object",
    "required": ["surface", "findings"],
    "properties": {
        "surface": {"type": "string"},
        "reviewer": {"type": "string"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": list(FINDING_FIELDS),
                "properties": {
                    name: {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_TEXT,
                        "description": desc,
                        **({"enum": list(allowed)} if allowed else {}),
                    }
                    for name, (desc, allowed) in FINDING_FIELDS.items()
                },
            },
        },
    },
}


def validate_finding(
    item: Any,
    *,
    surfaces: Optional[Iterable[str]] = None,
    screenshots: Optional[Iterable[str]] = None,
) -> list[str]:
    """Why ``item`` is not a valid finding (empty list = valid).

    With ``surfaces`` / ``screenshots`` (from the review request) the finding
    must name a surface that was reviewed and a screenshot that exists in the run.
    """
    if not isinstance(item, dict):
        return [f"a finding must be an object, got {type(item).__name__}"]
    errors = []
    for name, (_desc, allowed) in FINDING_FIELDS.items():
        value = item.get(name)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{name}: required non-empty string")
        elif len(value) > MAX_TEXT:
            errors.append(f"{name}: longer than {MAX_TEXT} characters")
        elif allowed and value not in allowed:
            errors.append(f"{name}: {value!r} is not one of {', '.join(allowed)}")
    for extra in sorted(set(item) - set(FINDING_FIELDS)):
        errors.append(f"{extra}: unknown field")
    if surfaces is not None and isinstance(item.get("surface"), str):
        known = set(surfaces)
        if item["surface"] not in known:
            errors.append(f"surface: {item['surface']!r} was not reviewed ({', '.join(sorted(known))})")
    if screenshots is not None and isinstance(item.get("screenshot"), str):
        if item["screenshot"] not in set(screenshots):
            errors.append(f"screenshot: {item['screenshot']!r} is not a screenshot of this run")
    return errors


def validate_findings_file(
    doc: Any,
    *,
    surfaces: Optional[Iterable[str]] = None,
    screenshots: Optional[Iterable[str]] = None,
) -> tuple[list[dict], list[str]]:
    """Split one reviewer file into ``(valid findings, errors)``.

    Accepts the documented object or a bare list of findings. A finding that
    fails validation is left out and its errors are returned, prefixed with its
    position, so one bad entry never hides the good ones.
    """
    surfaces = list(surfaces) if surfaces is not None else None
    screenshots = list(screenshots) if screenshots is not None else None
    if isinstance(doc, dict):
        items = doc.get("findings")
        if not isinstance(items, list):
            return [], ["findings: required array"]
    elif isinstance(doc, list):
        items = doc
    else:
        return [], [f"expected an object with 'findings', got {type(doc).__name__}"]
    valid, errors, seen = [], [], set()
    for index, item in enumerate(items):
        problems = validate_finding(item, surfaces=surfaces, screenshots=screenshots)
        if not problems and item["id"] in seen:
            problems = [f"id: {item['id']!r} is used twice in this file"]
        if problems:
            label = item.get("id") if isinstance(item, dict) else None
            errors.extend(f"findings[{index}]{f' ({label})' if label else ''}: {p}" for p in problems)
            continue
        seen.add(item["id"])
        valid.append({name: item[name].strip() for name in FINDING_FIELDS})
    return valid, errors
