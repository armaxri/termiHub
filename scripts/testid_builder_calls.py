"""Resolve harness testid *builder* calls to the concrete ids they select (#5341).

The harness rarely writes a templated id out in full. It wraps it in a helper::

    def open_settings_category(self, category: str) -> None:
        nav = f"settings-nav-{category}"
        self.driver.click(nav)

    self.open_settings_category("appearance")

The drift guard used to see only the static prefix ``settings-nav-``, so a typo in
the call (``"apperance"``) could never be caught. This module finds such helpers
— a function whose parameter reaches a ``Driver`` selector call, either directly
or through ``f"<prefix>{param}<suffix>"`` (inline, via one local variable, or as
the return value of a ``*testid*`` builder) — and turns every call site with a
string-literal argument into a concrete literal reference
(``settings-nav-appearance``), which the guard then checks like any other.

Helpers whose name is defined more than once with different templates are
ambiguous and skipped: a wrong mapping would invent drift.

Requires: Python 3.8+ (standard library only).
"""

from __future__ import annotations

import ast

# (param name, positional index for ``obj.f(...)``, for ``f(...)``, prefix, suffix)
Template = "tuple[str, int, int, str, str]"


def _param_template(node: ast.AST, params: "set[str]"):
    """``(param, prefix, suffix)`` when ``node`` is ``param`` or ``f"pre{param}suf"``."""
    if isinstance(node, ast.Name) and node.id in params:
        return node.id, "", ""
    if not isinstance(node, ast.JoinedStr):
        return None
    parts = list(node.values)
    prefix = suffix = ""
    if parts and isinstance(parts[0], ast.Constant):
        prefix = parts.pop(0).value
    if parts and isinstance(parts[-1], ast.Constant):
        suffix = parts.pop().value
    if len(parts) != 1:
        return None
    value = parts[0]
    if not (
        isinstance(value, ast.FormattedValue)
        and value.conversion == -1
        and value.format_spec is None
        and isinstance(value.value, ast.Name)
        and value.value.id in params
    ):
        return None
    if not isinstance(prefix, str) or not isinstance(suffix, str):
        return None
    return value.value.id, prefix, suffix


def _selector_args(func: ast.FunctionDef, methods_arg0: "set[str]", methods_two: "set[str]"):
    for node in ast.walk(func):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in methods_arg0 and node.args:
                yield node.args[0]
            elif node.func.attr in methods_two:
                yield from node.args[:2]


def function_templates(
    tree: ast.AST, methods_arg0: "set[str]", methods_two: "set[str]"
) -> "dict[str, set]":
    """Map helper name -> set of templates for every testid helper in ``tree``."""
    out: "dict[str, set]" = {}
    for func in ast.walk(tree):
        if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        names = [a.arg for a in func.args.posonlyargs + func.args.args]
        params = set(names) - {"self", "cls"}
        if not params:
            continue
        # One-hop locals: ``nav = f"settings-nav-{category}"``.
        local: "dict[str, tuple]" = {}
        for node in ast.walk(func):
            if (
                isinstance(node, ast.Assign)
                and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
            ):
                tmpl = _param_template(node.value, params)
                if tmpl:
                    local[node.targets[0].id] = tmpl
        found = set()
        for arg in _selector_args(func, methods_arg0, methods_two):
            tmpl = _param_template(arg, params)
            if tmpl is None and isinstance(arg, ast.Name):
                tmpl = local.get(arg.id)
            if tmpl:
                found.add(tmpl)
        if "testid" in func.name.lower():
            for node in ast.walk(func):
                if isinstance(node, ast.Return) and node.value is not None:
                    tmpl = _param_template(node.value, params)
                    if tmpl and tmpl[1]:
                        found.add(tmpl)
        bound = 1 if names[:1] in (["self"], ["cls"]) else 0
        for param, prefix, suffix in found:
            idx = names.index(param)
            out.setdefault(func.name, set()).add(
                (param, idx - bound, idx, prefix, suffix)
            )
    return out


def merge(maps: "list[dict[str, set]]") -> "dict[str, set]":
    """Union per-file maps, dropping names defined with conflicting templates."""
    merged: "dict[str, set]" = {}
    for m in maps:
        for name, tmpls in m.items():
            merged.setdefault(name, set()).update(tmpls)
    return {name: t for name, t in merged.items() if len(t) == 1}


def call_literals(tree: ast.AST, templates: "dict[str, set]", const: "dict[str, str]"):
    """Concrete ids built by helper calls in ``tree`` with a literal argument."""
    out: "set[str]" = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if isinstance(node.func, ast.Attribute):
            name, attr_call = node.func.attr, True
        elif isinstance(node.func, ast.Name):
            name, attr_call = node.func.id, False
        else:
            continue
        for param, attr_idx, plain_idx, prefix, suffix in templates.get(name, ()):
            idx = attr_idx if attr_call else plain_idx
            arg = next((k.value for k in node.keywords if k.arg == param), None)
            if arg is None and 0 <= idx < len(node.args):
                arg = node.args[idx]
            value = None
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                value = arg.value
            elif isinstance(arg, ast.Name):
                value = const.get(arg.id)
            elif isinstance(arg, ast.Attribute):
                value = const.get(arg.attr)
            if value is not None:
                out.add(prefix + value + suffix)
    return out
