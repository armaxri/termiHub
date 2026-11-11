"""Classify templated ``data-testid`` globs and expand registry-backed ones (#5341).

The testid catalog renders a template such as ``settings-nav-${cat.id}`` as the
glob ``settings-nav-*``. Matching harness ids against that glob lets a typo
(``settings-nav-apperance``) or a removed category through. This module reads
``tests/system/testid-templates.json`` and puts each glob into one bucket:

* **registry** — the interpolated value comes from a literal union or a const
  array in ``src/**``. The concrete members are read from that TypeScript source,
  so only ``settings-nav-<member>`` ids are valid.
* **dynamic** — declared as runtime data (file names, indexes, generated ids):
  any suffix is valid. Listed with a reason so the choice is visible.
* **stem** — the glob starts with ``*``: a caller-supplied stem
  (``${testIdBase}-confirm``). Any stem is valid; classified automatically.
* **unclassified** — none of the above. Matched as a plain glob, and the guard
  reports every harness id that relies on one.

A registry entry that cannot be resolved (missing file, missing declaration, a
member that is not a literal, a glob with more than one ``*``) falls back to
plain glob matching and is reported as a *problem*. It never passes or fails
silently.

Requires: Python 3.8+ (standard library only).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

REGISTRY = "registry"
DYNAMIC = "dynamic"
STEM = "stem"
UNCLASSIFIED = "unclassified"

_STRING = re.compile(r"""^(["'])(.*)\1$""", re.S)
_NUMBER = re.compile(r"^-?\d+(?:\.\d+)?$")


class ResolveError(Exception):
    """A registry entry whose members cannot be read from its TypeScript source."""


# ---------------------------------------------------------------------------
# Minimal TypeScript text helpers
# ---------------------------------------------------------------------------


def strip_comments(text: str) -> str:
    """Remove ``//`` and ``/* */`` comments, leaving string contents untouched."""
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in "\"'`":
            j = i + 1
            while j < n and text[j] != ch:
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _balanced(text: str, start: int, open_ch: str, close_ch: str) -> str:
    """The inner text of the bracket pair opening at ``text[start]``."""
    depth = 0
    i = start
    while i < len(text):
        ch = text[i]
        if ch in "\"'`":
            j = i + 1
            while j < len(text) and text[j] != ch:
                j += 2 if text[j] == "\\" else 1
            i = j + 1
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start + 1 : i]
        i += 1
    raise ResolveError(f"unbalanced {open_ch}{close_ch}")


def _split_top(text: str, sep: str) -> "list[str]":
    """Split on ``sep`` outside of brackets and strings."""
    parts, depth, cur, i = [], 0, [], 0
    while i < len(text):
        ch = text[i]
        if ch in "\"'`":
            j = i + 1
            while j < len(text) and text[j] != ch:
                j += 2 if text[j] == "\\" else 1
            cur.append(text[i : j + 1])
            i = j + 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
        i += 1
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


def _literal(token: str) -> str:
    """The value of a string/number literal token, or :class:`ResolveError`."""
    m = _STRING.match(token)
    if m:
        return m.group(2)
    if _NUMBER.match(token):
        return token
    raise ResolveError(f"non-literal member {token!r}")


def _union_members(expr: str) -> "list[str]":
    return [_literal(part) for part in _split_top(expr, "|")]


def _const_array(text: str, name: str) -> str:
    m = re.search(rf"\bconst\s+{re.escape(name)}\b[^=]*=\s*\[", text)
    if not m:
        raise ResolveError(f"const {name} = [...] not found")
    return _balanced(text, m.end() - 1, "[", "]")


# ---------------------------------------------------------------------------
# Extractors
# ---------------------------------------------------------------------------


def _extract_union(text: str, spec: dict) -> "list[str]":
    name = spec["type"]
    m = re.search(rf"\btype\s+{re.escape(name)}\s*=", text)
    if not m:
        raise ResolveError(f"type {name} not found")
    end = text.find(";", m.end())
    if end < 0:
        raise ResolveError(f"type {name} has no terminating ';'")
    return _union_members(text[m.end() : end])


def _extract_property_union(text: str, spec: dict) -> "list[str]":
    name, prop = spec["type"], spec["property"]
    m = re.search(rf"\btype\s+{re.escape(name)}\s*=\s*\{{", text)
    if not m:
        raise ResolveError(f"type {name} = {{...}} not found")
    body = _balanced(text, m.end() - 1, "{", "}")
    for field in _split_top(body.replace(";", ","), ","):
        key, _, value = field.partition(":")
        if key.strip().rstrip("?") == prop:
            return _union_members(value)
    raise ResolveError(f"property {name}.{prop} not found")


def _consts(spec: dict) -> "list[str]":
    names = spec["const"]
    return [names] if isinstance(names, str) else list(names)


def _extract_array(text: str, spec: dict) -> "list[str]":
    out: "list[str]" = []
    for name in _consts(spec):
        out += [_literal(el) for el in _split_top(_const_array(text, name), ",")]
    return out


def _extract_object_field(text: str, spec: dict) -> "list[str]":
    field = spec["field"]
    out: "list[str]" = []
    for name in _consts(spec):
        for element in _split_top(_const_array(text, name), ","):
            if not element.startswith("{"):
                raise ResolveError(f"{name}: element {element[:40]!r} is not an object")
            values = [
                v.strip()
                for k, _, v in (p.partition(":") for p in _split_top(element[1:-1], ","))
                if k.strip().strip("\"'") == field
            ]
            if len(values) != 1:
                raise ResolveError(f"{name}: an element has no literal {field!r}")
            out.append(_literal(values[0]))
    return out


_EXTRACTORS = {
    "union": _extract_union,
    "property-union": _extract_property_union,
    "array": _extract_array,
    "object-field": _extract_object_field,
}

# Mirrors of the expression the component applies to the value before
# interpolating it (``label.toLowerCase().replace(/\s+/g, "-")`` etc.).
_TRANSFORMS = {
    None: lambda v: v,
    "kebab-lower": lambda v: re.sub(r"\s+", "-", v.lower()),
    "strip-hash": lambda v: v.replace("#", "", 1),
}


def extract_members(text: str, extract: dict, transform: "str | None" = None) -> "list[str]":
    """Members named by one ``extract`` spec in TypeScript ``text``.

    Raises :class:`ResolveError` when the declaration is missing, any member is
    not a literal, or the result is empty — partial expansion would make a
    valid id look like drift.
    """
    kind = extract.get("kind")
    if kind not in _EXTRACTORS:
        raise ResolveError(f"unknown extract kind {kind!r}")
    if transform not in _TRANSFORMS:
        raise ResolveError(f"unknown transform {transform!r}")
    members = _EXTRACTORS[kind](strip_comments(text), extract)
    if not members:
        raise ResolveError("no members")
    return sorted({_TRANSFORMS[transform](m) for m in members})


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def load_config(path: Path) -> dict:
    """Read the template config; a missing file is an empty config."""
    if not path.exists():
        return {"registry": [], "dynamic": {}}
    return json.loads(path.read_text(encoding="utf-8"))


def classify(globs: "list[str]", config: dict, repo_root: Path) -> dict:
    """Classify every source glob.

    Returns ``{"kind": {glob: kind}, "members": {glob: [..]}, "source":
    {glob: "path (decl)"}, "reason": {glob: str}, "problems": [str]}``.
    Registry globs that fail to resolve are left out of ``members`` (so they
    fall back to plain glob matching) and described in ``problems``.
    """
    known = set(globs)
    kind = {g: (STEM if g.startswith("*") else UNCLASSIFIED) for g in globs}
    members: "dict[str, list[str]]" = {}
    source: "dict[str, str]" = {}
    reason: "dict[str, str]" = {}
    problems: "list[str]" = []

    for glob, why in config.get("dynamic", {}).items():
        if glob not in known:
            problems.append(f"dynamic glob {glob!r} is not rendered by src/** (stale config)")
            continue
        kind[glob] = DYNAMIC
        reason[glob] = why

    for entry in config.get("registry", []):
        rel = entry.get("source", "")
        label = f"{rel} ({_describe(entry.get('extract', {}))})"
        try:
            path = repo_root / rel
            if not rel or not path.is_file():
                raise ResolveError(f"source file {rel!r} not found")
            values = extract_members(
                path.read_text(encoding="utf-8"), entry.get("extract", {}), entry.get("transform")
            )
        except (ResolveError, KeyError) as err:
            values = None
            problems.append(f"registry {label} for {entry.get('globs')}: {err}")
        for glob in entry.get("globs", []):
            if glob not in known:
                problems.append(f"registry glob {glob!r} is not rendered by src/** (stale config)")
                continue
            kind[glob] = REGISTRY
            source[glob] = label
            if values is None:
                continue
            if glob.count("*") != 1:
                problems.append(f"registry glob {glob!r} needs exactly one '*' to expand")
                continue
            members[glob] = values
    return {
        "kind": kind,
        "members": members,
        "source": source,
        "reason": reason,
        "problems": problems,
    }


def _describe(extract: dict) -> str:
    if "type" in extract and "property" in extract:
        return f"{extract['type']}.{extract['property']}"
    if "type" in extract:
        return f"type {extract['type']}"
    if "const" in extract:
        names = ", ".join([extract["const"]] if isinstance(extract["const"], str) else extract["const"])
        return names + (f".{extract['field']}" if "field" in extract else "")
    return "?"


def expansions(members: "dict[str, list[str]]") -> "dict[str, set[str]]":
    """Concrete ids per expanded registry glob (``settings-nav-general`` …)."""
    return {g: {g.replace("*", m) for m in vals} for g, vals in members.items()}
