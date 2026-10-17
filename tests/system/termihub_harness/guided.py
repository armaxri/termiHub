"""Pure helpers for the guided-manual suites that need real hosts or hardware (#919).

The guided-manual tests in ``tests/system/tests/test_real_hardware.py`` and the
``test_guided_*.py`` suites run only with an operator (``--manual`` + a TTY), so
their app-driving parts never run in CI. Everything they decide *before* the
app is touched lives here instead, as plain functions the machinery suite
(``tests/test_guided_helpers.py``) exercises on every PR:

- **Real-host specs.** The operator names a real remote host (a Windows notebook,
  a Raspberry Pi) through an environment variable such as
  ``TERMIHUB_REAL_AGENT_HOST=user@host:22``; :func:`parse_host_spec` turns it
  into a :class:`HostSpec` and rejects malformed values with a message that says
  what to fix.
- **Other termiHub instances.** The operator usually runs an installed termiHub
  next to the test instance (the maintainer runs Claude inside one). A step that
  would quit "termiHub" by name — AppleScript ``quit app "termiHub"``, a Dock
  Quit, a logout — would hit that installed app too. The harness never sends
  such a quit itself; :func:`other_termihub_pids` lets a test detect the other
  instance and skip the by-name step instead of risking it. It only *reads* the
  process list, by verified PID; it never signals anything.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Iterable, Optional

#: A real remote host to deploy the agent to and open sessions on (any OS/arch).
REAL_AGENT_HOST_ENV = "TERMIHUB_REAL_AGENT_HOST"
#: A real Windows host running the agent, with Docker Desktop (Linux containers).
WINDOWS_AGENT_HOST_ENV = "TERMIHUB_WINDOWS_AGENT_HOST"
#: A physical serial device path (``/dev/ttyUSB0``, ``/dev/cu.usbserial-…``, ``COM3``).
SERIAL_DEVICE_ENV = "TERMIHUB_SERIAL_DEVICE"
#: A real Windows RDP host (``user@host[:port]``; a domain user is ``DOMAIN\\user``).
RDP_HOST_ENV = "TERMIHUB_RDP_HOST"

_HOST_SPEC = re.compile(
    r"^(?P<user>[^@\s]+)@(?:\[(?P<v6>[0-9A-Fa-f:.]+)\]|(?P<host>[^:\s\[\]@]+))"
    r"(?::(?P<port>\d+))?$"
)


@dataclass(frozen=True)
class HostSpec:
    """A ``user@host[:port]`` target named by the operator."""

    user: str
    host: str
    port: int = 22

    def __str__(self) -> str:
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{self.user}@{host}:{self.port}"


def parse_host_spec(spec: str, *, default_port: int = 22) -> HostSpec:
    """Parse ``user@host``, ``user@host:port`` or ``user@[v6addr]:port``.

    Raises ``ValueError`` naming the expected shape when ``spec`` does not match
    or the port is outside 1..65535, so a typo in the operator's environment
    fails with a fix-it message instead of a confusing connect error.
    """
    match = _HOST_SPEC.match(spec.strip())
    if not match:
        raise ValueError(
            f"expected user@host[:port] (IPv6 as user@[addr]:port), got {spec!r}"
        )
    port = int(match.group("port")) if match.group("port") else default_port
    if not 1 <= port <= 65535:
        raise ValueError(f"port must be 1..65535, got {port} in {spec!r}")
    host = match.group("v6") or match.group("host")
    return HostSpec(user=match.group("user"), host=host, port=port)


def host_from_env(
    var: str, *, environ: Optional[dict] = None, default_port: int = 22
) -> Optional[HostSpec]:
    """The :class:`HostSpec` named by ``var``, or ``None`` when it is unset/blank."""
    value = (os.environ if environ is None else environ).get(var, "").strip()
    return parse_host_spec(value, default_port=default_port) if value else None


def missing_env_reason(var: str, example: str, purpose: str) -> str:
    """The skip reason for a guided test whose real host/device is not named."""
    return f"set {var}={example} to run this guided test ({purpose})"


# ── Other termiHub instances (never quit by name) ────────────────────────────
_AGENT_SUFFIXES = ("-agent", "_agent", "-plugin-runner", "-rdp-sidecar")


def is_termihub_app_name(name: str) -> bool:
    """Whether a process name is the termiHub desktop app (not its agent/helpers)."""
    base = os.path.basename(name or "").lower()
    if base.endswith(".exe"):
        base = base[: -len(".exe")]
    if not base.startswith("termihub"):
        return False
    return not any(base.endswith(suffix) for suffix in _AGENT_SUFFIXES)


def other_termihub_pids(
    processes: Iterable[tuple[int, str]], own_pids: Iterable[int]
) -> list[int]:
    """PIDs of termiHub app processes that are *not* the test instance.

    ``processes`` is ``(pid, name)`` pairs (as ``psutil.process_iter`` yields);
    ``own_pids`` is the test instance's PID plus its children. Pure, so the
    matching rules are unit-tested without a process table.
    """
    own = set(own_pids)
    return sorted(
        pid for pid, name in processes if pid not in own and is_termihub_app_name(name)
    )


def running_other_termihub_pids(own_pids: Iterable[int]) -> list[int]:
    """Read the live process table and return the other termiHub app PIDs."""
    import psutil

    rows: list[tuple[int, str]] = []
    for proc in psutil.process_iter(["pid", "name"]):
        info = proc.info
        rows.append((int(info.get("pid") or 0), str(info.get("name") or "")))
    return other_termihub_pids(rows, own_pids)
