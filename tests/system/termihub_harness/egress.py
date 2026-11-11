"""Egress probe for the app under test (#5388, TST-005).

The app under test should never reach the internet: the harness profile turns
the update and plugin-index checks off (:mod:`termihub_harness.profile_defaults`)
and a test that grades those features points them at a loopback fixture server
(``TERMIHUB_TEST_HTTP_BASE``). This module checks that per test:

* **Sampling.** From the start of a test's setup to the end of its call phase a
  background thread lists the app PID's connected sockets (``psutil``) every
  :data:`SAMPLE_INTERVAL` seconds. A destination already connected when the test
  started (a fixture session an earlier test opened) is not new.
* **Fixture allowlist.** Loopback, private (RFC 1918, ULA), link-local and
  carrier-grade-NAT destinations are where the harness's fixtures live (native
  sshd, Docker containers and their per-checkout subnets); they never count.
  ``TERMIHUB_EGRESS_ALLOW`` adds comma-separated CIDRs or ``ip:port`` entries.
* **Test allowlist.** ``egress-allowlist.d/*.json`` fragments, one per test (or
  destination) that legitimately reaches the internet:
  ``{"nodeid"?: <regex>, "remote"?: <regex>, "issue": <n>, "reason": <text>}``,
  at least one of ``nodeid``/``remote``. ``remote`` is searched in ``ip:port``.
* **Mode.** ``TERMIHUB_EGRESS_GATE=fail|annotate|off`` (default ``annotate``).
  ``fail`` turns a passing test with a new, un-allowlisted destination into a
  failure; ``annotate`` only reports. Both list every destination with its tests
  in the terminal summary and in ``artifacts/egress/<lane>.json``.

Sampling is best effort: a connection that opens and closes between two samples
is missed. The pure parts (classification, diffing, matching, verdicts) take no
I/O so the machinery lane tests them directly (``tests/test_egress.py``).
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Optional, Sequence

from .js_errors import suite_handles

SYSTEM_DIR = Path(__file__).resolve().parents[1]
ALLOWLIST_DIR = SYSTEM_DIR / "egress-allowlist.d"
GATE_ENV = "TERMIHUB_EGRESS_GATE"
ALLOW_ENV = "TERMIHUB_EGRESS_ALLOW"
MODES = ("fail", "annotate", "off")
DEFAULT_MODE = "annotate"
#: Seconds between two samples of the app's sockets.
SAMPLE_INTERVAL = 0.2

#: Where the harness's fixtures live; a connection here is never egress.
FIXTURE_NETWORKS = tuple(
    ipaddress.ip_network(n)
    for n in (
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "169.254.0.0/16",
        "0.0.0.0/32",
        "::1/128",
        "::/128",
        "fc00::/7",
        "fe80::/10",
    )
)


class GateConfigError(ValueError):
    """A bad ``TERMIHUB_EGRESS_*`` value or allowlist fragment."""


def gate_mode(env: Mapping[str, str] = os.environ) -> str:
    """The configured mode; ``annotate`` when unset."""
    value = env.get(GATE_ENV, "").strip().lower() or DEFAULT_MODE
    if value not in MODES:
        raise GateConfigError(f"{GATE_ENV}={value!r}: expected one of {', '.join(MODES)}")
    return value


# ── Destinations ─────────────────────────────────────────────────────────────


@dataclass(frozen=True, order=True)
class Endpoint:
    """One remote address the app had a socket connected to."""

    ip: str
    port: int

    @property
    def key(self) -> str:
        host = f"[{self.ip}]" if ":" in self.ip else self.ip
        return f"{host}:{self.port}"

    def to_json(self) -> dict[str, Any]:
        return {"ip": self.ip, "port": self.port}


def _address(ip: str) -> Optional[ipaddress._BaseAddress]:
    try:
        address = ipaddress.ip_address(ip.split("%", 1)[0])
    except ValueError:
        return None
    mapped = getattr(address, "ipv4_mapped", None)
    return mapped or address


@dataclass(frozen=True)
class ExtraAllow:
    """One ``TERMIHUB_EGRESS_ALLOW`` entry: a network, optionally one port."""

    network: Any
    port: Optional[int] = None

    def matches(self, endpoint: Endpoint) -> bool:
        address = _address(endpoint.ip)
        if address is None or address.version != self.network.version:
            return False
        return address in self.network and self.port in (None, endpoint.port)


def parse_extra_allow(raw: str) -> list[ExtraAllow]:
    """Parse ``TERMIHUB_EGRESS_ALLOW``: comma-separated CIDRs or ``ip:port``."""
    entries: list[ExtraAllow] = []
    for item in (part.strip() for part in raw.split(",")):
        if not item:
            continue
        port: Optional[int] = None
        host = item
        match = re.fullmatch(r"\[(?P<v6>[^\]]+)\]:(?P<p>\d+)|(?P<v4>[^:]+):(?P<p4>\d+)", item)
        if match:
            host = match.group("v6") or match.group("v4")
            port = int(match.group("p") or match.group("p4"))
        try:
            network = ipaddress.ip_network(host, strict=False)
        except ValueError as exc:
            raise GateConfigError(f"{ALLOW_ENV}: {item!r} is not a CIDR or ip:port") from exc
        entries.append(ExtraAllow(network, port))
    return entries


def is_fixture(endpoint: Endpoint, extra: Sequence[ExtraAllow] = ()) -> bool:
    """Whether ``endpoint`` is a fixture destination (never egress)."""
    address = _address(endpoint.ip)
    if address is None:
        return False
    if any(address.version == n.version and address in n for n in FIXTURE_NETWORKS):
        return True
    return any(entry.matches(endpoint) for entry in extra)


def new_endpoints(baseline: Iterable[Endpoint], observed: Iterable[Endpoint]) -> list[Endpoint]:
    """Destinations seen during a test that were not connected at its start."""
    before = set(baseline)
    return sorted(set(observed) - before)


# ── Sampling ─────────────────────────────────────────────────────────────────


def connected_endpoints(pid: Optional[int]) -> set[Endpoint]:
    """The remote ends of ``pid``'s connected inet sockets (never raises)."""
    if pid is None:
        return set()
    try:
        import psutil

        process = psutil.Process(pid)
        lister = getattr(process, "net_connections", None) or process.connections
        conns = lister(kind="inet")
    except Exception:  # noqa: BLE001 - a gone/denied process just has no sockets
        return set()
    out: set[Endpoint] = set()
    for conn in conns:
        raddr = getattr(conn, "raddr", None)
        if raddr and getattr(raddr, "ip", None):
            out.add(Endpoint(str(raddr.ip), int(raddr.port)))
    return out


def app_pid(app: Any) -> Optional[int]:
    """The app's pid, or ``None`` (never raises)."""
    try:
        pid = getattr(app, "pid", None)
    except Exception:  # noqa: BLE001
        return None
    return pid if isinstance(pid, int) else None


class Sampler:
    """Polls one test's app sockets in a daemon thread until :meth:`stop`."""

    def __init__(
        self,
        pid_of: Callable[[], Optional[int]],
        *,
        lister: Callable[[Optional[int]], set[Endpoint]] = connected_endpoints,
        interval: float = SAMPLE_INTERVAL,
    ) -> None:
        self._pid_of = pid_of
        self._lister = lister
        self._interval = interval
        self.baseline: set[Endpoint] = self._sample()
        self.observed: set[Endpoint] = set(self.baseline)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="egress-sampler", daemon=True)
        self._thread.start()

    def _sample(self) -> set[Endpoint]:
        try:
            return self._lister(self._pid_of())
        except Exception:  # noqa: BLE001 - sampling must never break a test
            return set()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            self.observed |= self._sample()

    def stop(self) -> list[Endpoint]:
        """Take a last sample, stop, and return the new destinations."""
        self._stop.set()
        self._thread.join(timeout=2 * self._interval + 1)
        self.observed |= self._sample()
        return new_endpoints(self.baseline, self.observed)


# ── Allowlist ────────────────────────────────────────────────────────────────

_FRAGMENT_KEYS = {"nodeid", "remote", "issue", "reason"}
_ALLOWED_EXTRAS = {"README.md"}


@dataclass(frozen=True)
class AllowEntry:
    name: str
    issue: int
    reason: str
    nodeid: Optional[str] = None
    remote: Optional[str] = None

    def matches(self, endpoint: Endpoint, nodeid: str) -> bool:
        if self.nodeid is not None and not re.search(self.nodeid, nodeid):
            return False
        return self.remote is None or re.search(self.remote, endpoint.key) is not None


def parse_fragment(name: str, raw: Any) -> AllowEntry:
    """Validate one fragment: a scope that compiles, an issue, a reason."""
    if not isinstance(raw, Mapping):
        raise GateConfigError(f"egress allowlist fragment {name} must be a JSON object")
    unknown = sorted(k for k in raw if k not in _FRAGMENT_KEYS and not str(k).startswith("_"))
    if unknown:
        raise GateConfigError(f"egress allowlist fragment {name} has unknown key(s) {unknown}")
    issue, reason = raw.get("issue"), raw.get("reason")
    nodeid, remote = raw.get("nodeid"), raw.get("remote")
    if isinstance(issue, bool) or not isinstance(issue, int) or issue <= 0:
        raise GateConfigError(f"egress allowlist fragment {name} needs an 'issue' number")
    if not isinstance(reason, str) or not reason.strip():
        raise GateConfigError(f"egress allowlist fragment {name} needs a 'reason'")
    if nodeid is None and remote is None:
        raise GateConfigError(f"egress allowlist fragment {name} needs a 'nodeid' or 'remote'")
    for key, value in (("nodeid", nodeid), ("remote", remote)):
        if value is None:
            continue
        if not isinstance(value, str) or not value:
            raise GateConfigError(f"egress allowlist fragment {name}: '{key}' must be a regex")
        try:
            re.compile(value)
        except re.error as exc:
            raise GateConfigError(f"egress allowlist fragment {name}: bad regex: {exc}") from exc
    return AllowEntry(name, issue, reason.strip(), nodeid, remote)


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
    """One test's new non-fixture destinations, split into new and allowlisted."""

    nodeid: str
    new: list[Endpoint] = field(default_factory=list)
    allowed: list[tuple[Endpoint, AllowEntry]] = field(default_factory=list)

    @property
    def empty(self) -> bool:
        return not self.new and not self.allowed

    def to_json(self) -> dict[str, Any]:
        return {
            "nodeid": self.nodeid,
            "new": [e.to_json() for e in self.new],
            "allowed": [
                {**e.to_json(), "issue": entry.issue, "allowlist": entry.name}
                for e, entry in self.allowed
            ],
        }


def evaluate(
    nodeid: str,
    endpoints: Sequence[Endpoint],
    allowlist: Sequence[AllowEntry],
    extra: Sequence[ExtraAllow] = (),
) -> TestVerdict:
    """Drop fixture destinations; split the rest into new and allowlisted. Pure."""
    verdict = TestVerdict(nodeid)
    for endpoint in sorted(set(endpoints)):
        if is_fixture(endpoint, extra):
            continue
        entry = next((e for e in allowlist if e.matches(endpoint, nodeid)), None)
        if entry is None:
            verdict.new.append(endpoint)
        else:
            verdict.allowed.append((endpoint, entry))
    return verdict


def failure_message(verdict: TestVerdict) -> Optional[str]:
    """The text a ``fail``-mode test fails with, or ``None`` when nothing is new."""
    if not verdict.new:
        return None
    lines = [
        f"Egress probe ({GATE_ENV}=fail, #5388): the app under test connected to "
        f"{len(verdict.new)} non-fixture destination(s) during this test that no "
        f"{ALLOWLIST_DIR.name}/ entry covers:"
    ]
    lines.extend(f"  - {endpoint.key}" for endpoint in verdict.new)
    lines.append(
        "Point the feature at a loopback fixture (TERMIHUB_TEST_HTTP_BASE), or add an "
        f"{ALLOWLIST_DIR.name}/<issue>-<slug>.json entry if the test must reach it."
    )
    return "\n".join(lines)


# ── Reporting ────────────────────────────────────────────────────────────────


def format_summary(records: Sequence[Mapping[str, Any]], mode: str) -> list[str]:
    """Terminal-summary lines: each destination once, with its tests."""
    by_key: dict[str, dict[str, Any]] = {}
    for record in records:
        for bucket in ("new", "allowed"):
            for item in record.get(bucket) or []:
                key = Endpoint(item["ip"], int(item["port"])).key
                entry = by_key.setdefault(
                    key, {"tests": [], "issue": item.get("issue"), "new": bucket == "new"}
                )
                if record["nodeid"] not in entry["tests"]:
                    entry["tests"].append(record["nodeid"])
    if not by_key:
        return []
    new = sum(1 for v in by_key.values() if v["new"])
    lines = [
        f"mode={mode}: {len(by_key)} non-fixture destination(s) in {len(records)} test(s); "
        f"{new} not allowlisted"
    ]
    for key, info in sorted(by_key.items(), key=lambda kv: (not kv[1]["new"], kv[0])):
        tag = "NEW" if info["new"] else f"allowlisted #{info['issue']}"
        lines.append(f"[{tag}] {key}  ({len(info['tests'])} test(s))")
        lines.extend(f"    {nodeid}" for nodeid in info["tests"])
    return lines


def report_path(root: Path, lane: Optional[str]) -> Path:
    """``<artifacts>/egress/<lane>.json`` (``local.json`` outside a lane)."""
    name = re.sub(r"[^\w.-]", "_", lane) if lane else "local"
    return root / "egress" / f"{name}.json"


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


class Gate:
    """Per-session state: a sampler per running test, verdicts, the mode."""

    def __init__(
        self,
        mode: str,
        allowlist: Sequence[AllowEntry],
        extra: Sequence[ExtraAllow] = (),
        *,
        lister: Callable[[Optional[int]], set[Endpoint]] = connected_endpoints,
        interval: float = SAMPLE_INTERVAL,
    ) -> None:
        self.mode = mode
        self.allowlist = list(allowlist)
        self.extra = list(extra)
        self.records: list[dict[str, Any]] = []
        self._samplers: dict[str, Sampler] = {}
        self._lister = lister
        self._interval = interval

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Gate":
        mode = gate_mode(env)
        if mode == "off":
            return cls(mode, [])
        return cls(mode, load_allowlist(), parse_extra_allow(env.get(ALLOW_ENV, "")))

    def start(self, item: Any) -> None:
        """Before setup: start sampling the test's app (resolved on every tick)."""
        if self.mode == "off":
            return
        self._samplers[item.nodeid] = Sampler(
            lambda: app_pid(suite_handles(item)[1]),
            lister=self._lister,
            interval=self._interval,
        )

    def finish(self, item: Any, report: Any) -> None:
        """After the call phase: diff, record, and in ``fail`` mode fail the test."""
        sampler = self._samplers.pop(item.nodeid, None)
        if sampler is None:
            return
        endpoints = sampler.stop()
        verdict = evaluate(item.nodeid, endpoints, self.allowlist, self.extra)
        if verdict.empty:
            return
        self.records.append(verdict.to_json())
        message = failure_message(verdict)
        if self.mode == "fail" and message and report.passed:
            report.outcome = "failed"
            report.longrepr = message

    def abandon(self, item: Any) -> None:
        """Stop a sampler whose test never reached its call phase."""
        sampler = self._samplers.pop(item.nodeid, None)
        if sampler is not None:
            sampler.stop()
