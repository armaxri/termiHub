"""The UI-review finding schema — defined once, here (#5538, grades #5817).

A reviewer agent writes one JSON file per surface::

    {"surface": "chooser", "reviewer": "ui-review-chooser",
     "grade": 3, "grade_reason": "Users pick a store, but the hint misleads ...",
     "previous": [{"id": "R-002", "verdict": "fixed", "note": "one line now"}],
     "findings": [{"id": "chooser-1", "surface": "chooser",
                   "screenshot": "shots/checklist.chooser.recommended.png",
                   "severity": "P2", "kind": "looks",
                   "task": "pick where credentials are stored",
                   "finding": "The hint wraps to three lines at 1280 px ...",
                   "recommendation": "Shorten it to ..."}]}

``grade`` (1-5, usability first: :data:`GRADE_MEANING`) grades the whole
surface; ``previous`` (loop rounds only) gives a verdict on every finding of the
previous round. :data:`FINDING_FIELDS` is the single definition of the required
finding fields, :data:`OPTIONAL_FIELDS` of the optional ones.
:data:`FINDING_JSON_SCHEMA` (a JSON Schema rendered from them) goes into
``review-request.json`` so reviewers see the exact contract, and
:func:`validate_finding` / :func:`validate_findings_file` check reviewer output
against the same fields before anything is merged.

Older findings files stay valid: a file without ``grade`` is a legacy file, whose
findings may carry ``suggestion`` (the old name of ``recommendation``) and no
``task``. A graded file must give ``recommendation`` and ``task`` on every finding.
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

GRADES = (1, 2, 3, 4, 5)
#: Usability first: can the user do the task, understand, recognise, recover? Looks last.
GRADE_MEANING = {
    5: "excellent: the task succeeds first time, everything is understood and recognised, "
    "errors explain the way out; nothing worth changing",
    4: "good: the task succeeds without hesitation; only polish (P3) left",
    3: "usable with friction: the task succeeds, but the user hesitates, misreads something "
    "or recovers from an error only with effort",
    2: "poor: users often fail or misread the screen; recovery from an error is unclear",
    1: "broken: the task cannot be done, or the screen is wrong or unreadable",
}
GRADING_ORDER = (
    "task success (can the user do what the screen is for?)",
    "understandability (is it clear what the screen says and what each control does?)",
    "recognisability (consistent with the rest of the app; familiar controls and wording)",
    "error recovery (does a failure state say what happened and how to get out?)",
    "looks (only where they hurt one of the above or the design system)",
)
VERDICTS = ("fixed", "still-present", "regressed", "unclear")
VERDICT_MEANING = {
    "fixed": "the previous finding is no longer visible",
    "still-present": "unchanged or only partly fixed",
    "regressed": "worse than before, or the fix broke something else on this surface",
    "unclear": "the screenshots of this round do not show it",
}

#: name -> (description, allowed values or None). Every field is a required string.
FINDING_FIELDS: dict[str, tuple[str, Optional[tuple[str, ...]]]] = {
    "id": ("reviewer-local id, unique in its file, e.g. 'chooser-1'", None),
    "surface": ("the surface id from the review request", None),
    "screenshot": ("run-relative path of the screenshot it is seen on, e.g. 'shots/x.png'", None),
    "severity": ("P1 (worst) .. P3", SEVERITIES),
    "kind": ("looks | usefulness | bug", KINDS),
    "task": ("the user task the finding gets in the way of, e.g. 'pick a credential store'", None),
    "finding": ("what is wrong, concretely: where on the screen and why it matters", None),
    "recommendation": ("the concrete change that would fix it", None),
}
#: Optional string fields: ``suggestion`` is the legacy name of ``recommendation``.
OPTIONAL_FIELDS: dict[str, str] = {
    "suggestion": "legacy name of `recommendation` (older findings files); do not write it",
}
#: Fields a legacy (ungraded) file may leave out, and the legacy field standing in for one.
LEGACY_OPTIONAL = ("task",)
LEGACY_ALIASES = {"recommendation": "suggestion"}

def _string_schema(desc: str, allowed: Optional[tuple[str, ...]] = None) -> dict[str, Any]:
    return {
        "type": "string",
        "minLength": 1,
        "maxLength": MAX_TEXT,
        "description": desc,
        **({"enum": list(allowed)} if allowed else {}),
    }


FINDING_JSON_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "termiHub product-run UI review findings",
    "type": "object",
    "required": ["surface", "grade", "findings"],
    "properties": {
        "surface": {"type": "string"},
        "reviewer": {"type": "string"},
        "grade": {
            "type": "integer",
            "minimum": GRADES[0],
            "maximum": GRADES[-1],
            "description": "the whole surface, usability first: "
            + "; ".join(f"{g} = {m}" for g, m in sorted(GRADE_MEANING.items(), reverse=True)),
        },
        "grade_reason": _string_schema("one or two sentences: why this grade, task first"),
        "previous": {
            "type": "array",
            "description": "loop rounds only: a verdict on every finding of the previous round",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["id", "verdict"],
                "properties": {
                    "id": _string_schema("the previous round's merged id, e.g. 'R-002'"),
                    "verdict": _string_schema(" | ".join(VERDICTS), VERDICTS),
                    "note": _string_schema("what you see now"),
                },
            },
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": list(FINDING_FIELDS),
                "properties": {
                    **{
                        name: _string_schema(desc, allowed)
                        for name, (desc, allowed) in FINDING_FIELDS.items()
                    },
                    **{name: _string_schema(desc) for name, desc in OPTIONAL_FIELDS.items()},
                },
            },
        },
    },
}


def _text_error(name: str, value: Any, allowed: Optional[tuple[str, ...]] = None) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        return f"{name}: required non-empty string"
    if len(value) > MAX_TEXT:
        return f"{name}: longer than {MAX_TEXT} characters"
    if allowed and value not in allowed:
        return f"{name}: {value!r} is not one of {', '.join(allowed)}"
    return None


def validate_finding(
    item: Any,
    *,
    surfaces: Optional[Iterable[str]] = None,
    screenshots: Optional[Iterable[str]] = None,
    legacy: bool = True,
) -> list[str]:
    """Why ``item`` is not a valid finding (empty list = valid).

    With ``surfaces`` / ``screenshots`` (from the review request) the finding
    must name a surface that was reviewed and a screenshot that exists in the run.
    ``legacy`` (a file without ``grade``) also accepts the pre-#5817 shape:
    ``suggestion`` instead of ``recommendation`` and no ``task``.
    """
    if not isinstance(item, dict):
        return [f"a finding must be an object, got {type(item).__name__}"]
    errors = []
    for name, (_desc, allowed) in FINDING_FIELDS.items():
        value = item.get(name)
        if legacy and value is None:
            if name in LEGACY_OPTIONAL:
                continue
            if name in LEGACY_ALIASES and item.get(LEGACY_ALIASES[name]) is not None:
                continue
        error = _text_error(name, value, allowed)
        if error:
            errors.append(error)
    for name in OPTIONAL_FIELDS:
        if name in item:
            error = _text_error(name, item[name])
            if error:
                errors.append(error)
    for extra in sorted(set(item) - set(FINDING_FIELDS) - set(OPTIONAL_FIELDS)):
        errors.append(f"{extra}: unknown field")
    if surfaces is not None and isinstance(item.get("surface"), str):
        known = set(surfaces)
        if item["surface"] not in known:
            errors.append(f"surface: {item['surface']!r} was not reviewed ({', '.join(sorted(known))})")
    if screenshots is not None and isinstance(item.get("screenshot"), str):
        if item["screenshot"] not in set(screenshots):
            errors.append(f"screenshot: {item['screenshot']!r} is not a screenshot of this run")
    return errors


def normalize_finding(item: dict) -> dict:
    """A valid finding in the merged shape: every field, ``recommendation`` filled
    from a legacy ``suggestion`` (and ``suggestion`` kept equal for older readers),
    ``task`` empty when a legacy file had none."""
    out = {name: str(item.get(name) or "").strip() for name in FINDING_FIELDS}
    if not out["recommendation"]:
        out["recommendation"] = str(item.get("suggestion") or "").strip()
    out["suggestion"] = out["recommendation"]
    return out


def is_grade(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value in GRADES


def validate_grade_fields(doc: dict) -> list[str]:
    """Errors in a findings file's surface-level fields (``grade``, ``previous`` ...)."""
    errors = []
    if "grade" in doc and not is_grade(doc["grade"]):
        errors.append(f"grade: {doc['grade']!r} is not an integer 1..5")
    if "grade_reason" in doc:
        error = _text_error("grade_reason", doc["grade_reason"])
        if error:
            errors.append(error)
    previous = doc.get("previous")
    if previous is not None:
        if not isinstance(previous, list):
            return [*errors, "previous: must be an array"]
        for index, entry in enumerate(previous):
            if not isinstance(entry, dict):
                errors.append(f"previous[{index}]: must be an object")
                continue
            for name, allowed in (("id", None), ("verdict", VERDICTS)):
                error = _text_error(name, entry.get(name), allowed)
                if error:
                    errors.append(f"previous[{index}]: {error}")
            if "note" in entry and _text_error("note", entry["note"]):
                errors.append(f"previous[{index}]: {_text_error('note', entry['note'])}")
            for extra in sorted(set(entry) - {"id", "verdict", "note"}):
                errors.append(f"previous[{index}]: {extra}: unknown field")
    return errors


def surface_review(doc: Any) -> dict[str, Any]:
    """The surface-level part of a valid file: surface, reviewer, grade, reason, verdicts."""
    if not isinstance(doc, dict):
        return {}
    return {
        "surface": doc.get("surface") if isinstance(doc.get("surface"), str) else None,
        "reviewer": doc.get("reviewer") if isinstance(doc.get("reviewer"), str) else None,
        "grade": doc["grade"] if is_grade(doc.get("grade")) else None,
        "grade_reason": str(doc.get("grade_reason") or "").strip() or None,
        "previous": [
            {k: str(v).strip() for k, v in entry.items()}
            for entry in (doc.get("previous") or [])
            if isinstance(entry, dict)
        ],
    }


def validate_findings_file(
    doc: Any,
    *,
    surfaces: Optional[Iterable[str]] = None,
    screenshots: Optional[Iterable[str]] = None,
) -> tuple[list[dict], list[str]]:
    """Split one reviewer file into ``(valid findings, errors)``.

    Accepts the documented object or a bare list of findings (legacy). A finding
    that fails validation is left out and its errors are returned, prefixed with
    its position, so one bad entry never hides the good ones. A file with a
    ``grade`` is held to the full contract; one without is a legacy file.
    """
    surfaces = list(surfaces) if surfaces is not None else None
    screenshots = list(screenshots) if screenshots is not None else None
    errors: list[str] = []
    if isinstance(doc, dict):
        items = doc.get("findings")
        if not isinstance(items, list):
            return [], ["findings: required array"]
        errors.extend(validate_grade_fields(doc))
        legacy = "grade" not in doc
    elif isinstance(doc, list):
        items = doc
        legacy = True
    else:
        return [], [f"expected an object with 'findings', got {type(doc).__name__}"]
    valid, seen = [], set()
    for index, item in enumerate(items):
        problems = validate_finding(
            item, surfaces=surfaces, screenshots=screenshots, legacy=legacy
        )
        if not problems and item["id"] in seen:
            problems = [f"id: {item['id']!r} is used twice in this file"]
        if problems:
            label = item.get("id") if isinstance(item, dict) else None
            errors.extend(f"findings[{index}]{f' ({label})' if label else ''}: {p}" for p in problems)
            continue
        seen.add(item["id"])
        valid.append(normalize_finding(item))
    return valid, errors
