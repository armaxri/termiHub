"""JS error gate for the app under test (#5364, TST-011).

The real app can throw on every tab open (an unhandled ``Canceled`` rejection,
a ``console.error`` from a lost handler) and a bridge test still passes. This
module diffs the JavaScript errors a test caused and checks them against an
issue-bound allowlist:

* **Collection.** At the start of a test's setup :func:`take_cursor` records
  where the app's error stream stands; after the call phase :func:`collect`
  reads what was added since. The source is the bridge's ``getJsErrors`` buffer
  (preferred, OS-independent) or, when the bridge cannot answer (page dead, an
  older build), the ``app.log`` lines ``ERROR frontend: [unhandled] …`` and
  ``CONSOLE JS ERROR …`` (fallback).
* **Allowlist.** ``js-error-allowlist.d/*.json`` fragments, one per known error:
  ``{"pattern": <regex>, "issue": <n>, "reason": <text>, "nodeid"?: <regex>}``.
  The pattern is searched in the error's key (``<kind>: <first message line>``).
* **Mode.** ``TERMIHUB_JS_ERROR_GATE=fail|annotate|off`` (default ``annotate``).
  ``fail`` turns a passing test with a new, un-allowlisted error into a failure;
  ``annotate`` only reports. Both list every unique error with its tests in the
  terminal summary and in ``artifacts/js-errors/<lane>.json``.

The pure parts (parsing, diffing, matching, verdicts) take no I/O so the
machinery lane tests them directly (``tests/test_js_errors.py``).
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence

SYSTEM_DIR = Path(__file__).resolve().parents[1]
ALLOWLIST_DIR = SYSTEM_DIR / "js-error-allowlist.d"
GATE_ENV = "TERMIHUB_JS_ERROR_GATE"
MODES = ("fail", "annotate", "off")
DEFAULT_MODE = "annotate"
#: Bridge timeout for the per-test read: a hung webview must not stall teardown.
BRIDGE_TIMEOUT = 5.0
#: A ``since`` past any real cursor: asks only for the current cursor.
_CURSOR_PROBE = 2**31 - 1
#: Longest message key kept for matching and reporting.
_KEY_LIMIT = 300

_ANSI = re.compile(r"\x1b\[[0-9;]*m")
_LOG_UNHANDLED = re.compile(r"\bERROR\b.*?\bfrontend\b[\w:]*:\s*\[unhandled\]\s*(?P<msg>.*)")
_LOG_CONSOLE = re.compile(r"CONSOLE JS ERROR\s*:?\s*(?P<msg>.*)")
_TRAILING_FIELDS = re.compile(r'(\s+\w+="[^"]*")+\s*$')
#: Message prefixes that name the error's kind (frontend handler and WebKit echo).
_KIND_PREFIXES = (
    ("unhandled promise rejection:", "unhandledrejection"),
    ("uncaught error", "error"),
)
_KIND_UNHANDLED_KEY = "unhandledrejection"


class GateConfigError(ValueError):
    """A bad ``TERMIHUB_JS_ERROR_GATE`` value or allowlist fragment."""


def gate_mode(env: Mapping[str, str] = os.environ) -> str:
    """The configured mode; ``annotate`` when unset."""
    value = env.get(GATE_ENV, "").strip().lower() or DEFAULT_MODE
    if value not in MODES:
        raise GateConfigError(f"{GATE_ENV}={value!r}: expected one of {', '.join(MODES)}")
    return value


# ── Errors ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class JsError:
    """One JavaScript error the app produced."""

    kind: str
    message: str
    source: str  # "bridge" or "log"
    stack: Optional[str] = None

    @property
    def key(self) -> str:
        """``<kind>: <first message line>``: what dedups, matches and reports."""
        first = self.message.strip().splitlines()[0] if self.message.strip() else ""
        return f"{self.kind}: {first[:_KEY_LIMIT]}"

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {"kind": self.kind, "message": self.message, "source": self.source}
        if self.stack:
            data["stack"] = self.stack
        return data


def _classify(message: str, default_kind: str) -> tuple[str, str]:
    """Split a known kind prefix off a log message."""
    lowered = message.lower()
    for prefix, kind in _KIND_PREFIXES:
        if lowered.startswith(prefix):
            rest = message[len(prefix) :].lstrip(" :")
            # "uncaught error (file:1:2): boom" keeps the location in the message.
            return kind, rest
    return default_kind, message


def parse_log(text: str) -> list[JsError]:
    """The JS errors in an ``app.log`` excerpt, oldest first.

    Reads the frontend handler's ``ERROR frontend: [unhandled] …`` lines and
    WebKit's ``CONSOLE JS ERROR …`` echo; continuation lines (a stack) are not
    part of the record.
    """
    errors: list[JsError] = []
    for raw in text.splitlines():
        line = _ANSI.sub("", raw)
        match = _LOG_UNHANDLED.search(line)
        default = "error"
        if match is None:
            match = _LOG_CONSOLE.search(line)
            default = "console.error"
        if match is None:
            continue
        message = _TRAILING_FIELDS.sub("", match.group("msg")).strip()
        kind, message = _classify(message, default)
        errors.append(JsError(kind, message, "log"))
    return errors


def from_bridge(records: Iterable[Mapping[str, Any]]) -> list[JsError]:
    """:class:`JsError` s from ``getJsErrors`` records."""
    return [
        JsError(
            str(r.get("kind") or "error"),
            str(r.get("message") or ""),
            "bridge",
            r.get("stack") or None,
        )
        for r in records
    ]


def unique(errors: Iterable[JsError]) -> list[JsError]:
    """First occurrence of each :attr:`JsError.key`, in order.

    WebKit echoes a rejection the frontend handler also logs, and one bug often
    throws once per render, so a test reports each distinct error once.
    """
    seen: set[str] = set()
    out: list[JsError] = []
    for error in errors:
        if error.key not in seen:
            seen.add(error.key)
            out.append(error)
    return out


# ── Cursor + collection ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Cursor:
    """Where an app's error stream stood when a test started."""

    app_id: Optional[int] = None
    log_offset: int = 0
    page_id: Optional[str] = None
    seq: int = 0


def since_for(cursor: Cursor, page_id: str) -> int:
    """The ``since`` to read with: 0 when the page reloaded (or was unknown)."""
    return cursor.seq if cursor.page_id == page_id else 0


def log_offset_for(cursor: Cursor, app: Any) -> int:
    """The byte offset to read ``app.log`` from: 0 for an app launched since."""
    return cursor.log_offset if cursor.app_id == id(app) else 0


def _log_size(app: Any) -> int:
    try:
        return Path(app.log_path).stat().st_size
    except (AttributeError, OSError, TypeError):
        return 0


def _bridge_read(driver: Any, since: int) -> Optional[dict[str, Any]]:
    if driver is None or not getattr(driver, "is_connected", True):
        return None
    reader = getattr(driver, "get_js_errors", None)
    if reader is None:
        return None
    try:
        value = reader(since, timeout=BRIDGE_TIMEOUT)
    except Exception:  # noqa: BLE001 - an unreachable bridge falls back to the log
        return None
    return value if isinstance(value, dict) else None


def take_cursor(driver: Any, app: Any) -> Cursor:
    """The current position of ``app``'s error stream (never raises)."""
    value = _bridge_read(driver, _CURSOR_PROBE)
    return Cursor(
        app_id=id(app) if app is not None else None,
        log_offset=_log_size(app) if app is not None else 0,
        page_id=str(value["pageId"]) if value else None,
        seq=int(value.get("cursor", 0)) if value else 0,
    )


def collect(cursor: Cursor, driver: Any, app: Any) -> tuple[list[JsError], Optional[str]]:
    """The errors added since ``cursor`` and their source (never raises).

    The bridge answers when it can; otherwise the ``app.log`` tail is parsed.
    Returns ``([], None)`` when neither is available.
    """
    value = _bridge_read(driver, cursor.seq)
    if value is not None and since_for(cursor, str(value.get("pageId"))) != cursor.seq:
        # The page reloaded since the cursor was taken: its buffer restarted.
        value = _bridge_read(driver, 0)
    if value is not None:
        return from_bridge(value.get("errors") or []), "bridge"
    if app is None:
        return [], None
    try:
        with open(app.log_path, "rb") as handle:
            handle.seek(log_offset_for(cursor, app))
            text = handle.read().decode("utf-8", errors="replace")
    except (AttributeError, OSError, TypeError):
        return [], None
    return parse_log(text), "log"


# ── Allowlist ────────────────────────────────────────────────────────────────

_FRAGMENT_KEYS = {"pattern", "issue", "reason", "nodeid"}
#: Files the allowlist directory may hold besides ``*.json`` fragments.
_ALLOWED_EXTRAS = {"README.md"}


@dataclass(frozen=True)
class AllowEntry:
    name: str
    pattern: str
    issue: int
    reason: str
    nodeid: Optional[str] = None

    def matches(self, error: JsError, nodeid: str) -> bool:
        if self.nodeid is not None and not re.search(self.nodeid, nodeid):
            return False
        return re.search(self.pattern, error.key) is not None


def parse_fragment(name: str, raw: Any) -> AllowEntry:
    """Validate one fragment: a pattern that compiles, an issue, a reason."""
    if not isinstance(raw, Mapping):
        raise GateConfigError(f"js-error allowlist fragment {name} must be a JSON object")
    unknown = sorted(k for k in raw if k not in _FRAGMENT_KEYS and not str(k).startswith("_"))
    if unknown:
        raise GateConfigError(f"js-error allowlist fragment {name} has unknown key(s) {unknown}")
    pattern, issue, reason = raw.get("pattern"), raw.get("issue"), raw.get("reason")
    if not isinstance(pattern, str) or not pattern:
        raise GateConfigError(f"js-error allowlist fragment {name} needs a 'pattern'")
    if isinstance(issue, bool) or not isinstance(issue, int) or issue <= 0:
        raise GateConfigError(f"js-error allowlist fragment {name} needs an 'issue' number")
    if not isinstance(reason, str) or not reason.strip():
        raise GateConfigError(f"js-error allowlist fragment {name} needs a 'reason'")
    nodeid = raw.get("nodeid")
    try:
        re.compile(pattern)
        if nodeid is not None:
            re.compile(nodeid)
    except re.error as exc:
        raise GateConfigError(f"js-error allowlist fragment {name}: bad regex: {exc}") from exc
    return AllowEntry(name, pattern, issue, reason.strip(), nodeid)


def load_allowlist(directory: Path = ALLOWLIST_DIR) -> list[AllowEntry]:
    """Every ``*.json`` fragment in ``directory`` (none is fine)."""
    if not directory.is_dir():
        return []
    paths = sorted(directory.iterdir())
    stray = [
        p.name
        for p in paths
        if p.name not in _ALLOWED_EXTRAS and (p.suffix != ".json" or not p.is_file())
    ]
    if stray:
        raise GateConfigError(f"{directory.name}/ holds only *.json fragments, not {stray}")
    return [
        parse_fragment(p.name, json.loads(p.read_text(encoding="utf-8")))
        for p in paths
        if p.suffix == ".json"
    ]


# ── Verdict ──────────────────────────────────────────────────────────────────


@dataclass
class TestVerdict:
    """One test's errors, split into new and allowlisted ones."""

    nodeid: str
    source: Optional[str]
    new: list[JsError] = field(default_factory=list)
    allowed: list[tuple[JsError, AllowEntry]] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.new and not self.allowed

    def to_json(self) -> dict[str, Any]:
        return {
            "nodeid": self.nodeid,
            "source": self.source,
            "new": [e.to_json() for e in self.new],
            "allowed": [
                {**e.to_json(), "issue": entry.issue, "allowlist": entry.name}
                for e, entry in self.allowed
            ],
        }


def evaluate(
    nodeid: str,
    errors: Sequence[JsError],
    allowlist: Sequence[AllowEntry],
    *,
    source: Optional[str] = None,
) -> TestVerdict:
    """Split a test's (deduplicated) errors into new and allowlisted. Pure."""
    verdict = TestVerdict(nodeid, source)
    for error in unique(errors):
        entry = next((e for e in allowlist if e.matches(error, nodeid)), None)
        if entry is None:
            verdict.new.append(error)
        else:
            verdict.allowed.append((error, entry))
    return verdict


def failure_message(verdict: TestVerdict) -> Optional[str]:
    """The text a ``fail``-mode test fails with, or ``None`` when nothing is new."""
    if not verdict.new:
        return None
    lines = [
        f"JS error gate ({GATE_ENV}=fail, #5364): the app under test produced "
        f"{len(verdict.new)} JavaScript error(s) during this test (source: {verdict.source}) "
        f"that no {ALLOWLIST_DIR.name}/ entry covers:"
    ]
    for error in verdict.new:
        lines.append(f"  - {error.key}")
        if error.stack:
            lines.extend(f"      {frame}" for frame in error.stack.splitlines())
    lines.append(
        f"Fix the error, or add a {ALLOWLIST_DIR.name}/<issue>-<slug>.json entry "
        "tied to an issue that tracks it."
    )
    return "\n".join(lines)


# ── Reporting ────────────────────────────────────────────────────────────────


def format_summary(records: Sequence[Mapping[str, Any]], mode: str) -> list[str]:
    """Terminal-summary lines: each unique error once, with its tests."""
    by_key: dict[str, dict[str, Any]] = {}
    for record in records:
        for bucket in ("new", "allowed"):
            for error in record.get(bucket) or []:
                key = JsError(error["kind"], error["message"], error.get("source", "")).key
                entry = by_key.setdefault(
                    key, {"tests": [], "issue": error.get("issue"), "new": bucket == "new"}
                )
                if record["nodeid"] not in entry["tests"]:
                    entry["tests"].append(record["nodeid"])
    if not by_key:
        return []
    new = sum(1 for v in by_key.values() if v["new"])
    lines = [
        f"mode={mode}: {len(by_key)} unique JS error(s) in {len(records)} test(s); "
        f"{new} not allowlisted"
    ]
    for key, info in sorted(by_key.items(), key=lambda kv: (not kv[1]["new"], kv[0])):
        tag = "NEW" if info["new"] else f"allowlisted #{info['issue']}"
        lines.append(f"[{tag}] {key}  ({len(info['tests'])} test(s))")
        lines.extend(f"    {nodeid}" for nodeid in info["tests"])
    return lines


def report_path(root: Path, lane: Optional[str]) -> Path:
    """``<artifacts>/js-errors/<lane>.json`` (``local.json`` outside a lane)."""
    name = re.sub(r"[^\w.-]", "_", lane) if lane else "local"
    return root / "js-errors" / f"{name}.json"


def write_report(path: Path, records: Sequence[Mapping[str, Any]], mode: str) -> Optional[Path]:
    """Write the JSON artifact (never raises); ``None`` when it could not."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"mode": mode, "tests": list(records)}, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        return None
    return path


# ── pytest glue (kept here so conftest.py stays a thin caller) ────────────────


def suite_handles(item: Any) -> tuple[Any, Any]:
    """The ``(driver, app)`` a test drives: its suite's, else an ``app`` funcarg."""
    instance = getattr(item, "instance", None)
    cls = getattr(item, "cls", None)
    owner = instance if instance is not None else cls
    driver = getattr(owner, "driver", None) if owner is not None else None
    app = getattr(owner, "app", None) if owner is not None else None
    if app is None:
        app = (getattr(item, "funcargs", None) or {}).get("app")
    return driver, app


class Gate:
    """Per-session state: cursors per test, verdicts with errors, the mode."""

    def __init__(self, mode: str, allowlist: Sequence[AllowEntry]) -> None:
        self.mode = mode
        self.allowlist = list(allowlist)
        self.records: list[dict[str, Any]] = []
        self._cursors: dict[str, Cursor] = {}

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Gate":
        mode = gate_mode(env)
        return cls(mode, load_allowlist() if mode != "off" else [])

    def start(self, item: Any) -> None:
        """Before setup: remember where the test's app stream stands."""
        if self.mode == "off":
            return
        driver, app = suite_handles(item)
        self._cursors[item.nodeid] = take_cursor(driver, app)

    def finish(self, item: Any, report: Any) -> None:
        """After the call phase: diff, record, and in ``fail`` mode fail the test."""
        cursor = self._cursors.pop(item.nodeid, None)
        if self.mode == "off" or cursor is None:
            return
        driver, app = suite_handles(item)
        if driver is None and app is None:
            return  # a machinery test: no app under test
        errors, source = collect(cursor, driver, app)
        verdict = evaluate(item.nodeid, errors, self.allowlist, source=source)
        if verdict.empty:
            return
        self.records.append(verdict.to_json())
        message = failure_message(verdict)
        if self.mode == "fail" and message and report.passed:
            report.outcome = "failed"
            report.longrepr = message
