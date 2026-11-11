"""Session-start runner-tool preflight for the system-test lanes (#5340, TST-010).

The integration suites shell out to host tools the harness does not own:
``openbox`` / ``xprop`` / ``xdotool`` / ``xsettingsd`` on the Xvfb display,
``socat`` for the virtual serial ports, ``docker`` for the compose fixtures, a
loopback ``sshd`` for the local agent, and the harness's own ``code`` PATH shim.
Each check used to live inside a test's fixture or body, so one provisioning
mistake in ``.github/workflows/system-integration.yml`` surfaced as twenty
identical setup tracebacks, each retried by the rerun policy.

This module checks every tool the **selected** tests need exactly once, after
collection, and stops the session with one message naming the missing tools,
the lane and the workflow step that should have installed them.

Who needs what is declared next to the code that needs it, never as a per-lane
list:

* a test, class or module carries ``@pytest.mark.requires_tools("xdotool",
  platforms=("linux",))`` (``platforms`` narrows the tool's own platforms);
* a fixture is decorated with :func:`fixture_needs` (the conftest's docker
  fixtures, ``serial_echo_pair``), so every test that pulls it in, directly or
  through another fixture, counts;
* a :class:`~termihub_harness.SystemTest` class whose ``external_app_shims``
  include ``code`` needs the ``code`` shim.

A tool only counts on the platforms where its absence is a provisioning error
(:data:`TOOLS`): ``socat`` is not expected on Windows, Docker is not expected
on the macOS runner. A test whose own skip marks already skip it does not count.

Modes (``TERMIHUB_TOOL_PREFLIGHT``): ``strict`` stops the session with
:data:`EXIT_CODE`; ``warn`` prints the same message in the terminal summary and
lets the tests' own skips run (a developer box); ``off`` disables it. The
default is ``strict`` on a skip-guard lane or a GitHub runner and ``warn``
everywhere else. ``--collect-only`` never probes.

The decision logic is pure (:func:`requirements`, :func:`missing_tools`,
:func:`format_message`) and unit-tested in ``tests/test_tool_preflight.py``;
``conftest.py`` only wires it into the session.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Optional, Sequence

#: Env switch: ``strict`` / ``warn`` / ``off`` (see the module docstring).
MODE_ENV = "TERMIHUB_TOOL_PREFLIGHT"

#: The marker a test, class or module uses to declare the tools it needs.
MARKER = "requires_tools"

#: Session exit code when a strict preflight finds a missing tool. Distinct from
#: pytest's own codes (0-5) so a lane log reads "provisioning", not "tests".
EXIT_CODE = 6

#: The workflow that provisions the nightly lanes.
WORKFLOW = ".github/workflows/system-integration.yml"

_STRICT, _WARN, _OFF = "strict", "warn", "off"

#: Fixture name -> the tools it needs. Filled by :func:`fixture_needs`.
FIXTURE_TOOLS: dict[str, tuple[str, ...]] = {}


def _which(name: str) -> Callable[[], Optional[str]]:
    def probe() -> Optional[str]:
        return None if shutil.which(name) else "not on PATH"

    return probe


def _probe_sshd() -> Optional[str]:
    from .local_agent import _find_sshd

    return None if _find_sshd() else "no sshd binary (looked in /usr/sbin, /sbin, PATH)"


def _probe_docker() -> Optional[str]:
    from .fixtures import container_runtime

    if container_runtime() is not None:
        return None
    return "no working container runtime (docker/podman CLI missing or its daemon not answering)"


def _probe_code_shim() -> Optional[str]:
    from .external_shims import FAKE_CODE_VERSION, HandoffShims

    shims = HandoffShims(("code",))
    try:
        env = {**os.environ, **shims.app_env()}
        if sys.platform == "win32":
            argv = ["cmd", "/c", "code", "--version"]
        else:
            resolved = shutil.which("code", path=env["PATH"])
            if resolved is None:
                return "the harness's code shim does not resolve on its own PATH"
            argv = [resolved, "--version"]
        try:
            done = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as exc:
            return f"the harness's code shim did not run: {exc}"
        if done.returncode != 0 or FAKE_CODE_VERSION not in done.stdout:
            return f"the harness's code shim failed (rc={done.returncode}): {done.stderr.strip()}"
        return None
    finally:
        shims.close()


@dataclass(frozen=True)
class Tool:
    """One runner tool: where it is mandatory and how to check it once."""

    name: str
    #: Platforms (``linux`` / ``darwin`` / ``win32``) where a missing tool is a
    #: provisioning error. Elsewhere the tests' own skips decide.
    platforms: frozenset[str]
    #: Returns ``None`` when usable, else why not.
    probe: Callable[[], Optional[str]]
    #: What a developer runs to get it.
    local_hint: str


_LINUX = frozenset({"linux"})
_POSIX = frozenset({"linux", "darwin"})
_ALL = frozenset({"linux", "darwin", "win32"})

TOOLS: dict[str, Tool] = {
    tool.name: tool
    for tool in (
        Tool("openbox", _LINUX, _which("openbox"), "apt install openbox"),
        Tool("xprop", _LINUX, _which("xprop"), "apt install x11-utils"),
        Tool("xdotool", _LINUX, _which("xdotool"), "apt install xdotool"),
        Tool("xsettingsd", _LINUX, _which("xsettingsd"), "apt install xsettingsd"),
        Tool("Xvfb", _LINUX, _which("Xvfb"), "apt install xvfb"),
        Tool("xclip", _LINUX, _which("xclip"), "apt install xclip"),
        Tool("sway", _LINUX, _which("sway"), "apt install --no-install-recommends sway"),
        Tool("wl-paste", _LINUX, _which("wl-paste"), "apt install wl-clipboard"),
        Tool("wl-copy", _LINUX, _which("wl-copy"), "apt install wl-clipboard"),
        Tool("socat", _POSIX, _which("socat"), "apt install socat / brew install socat"),
        Tool("docker", _LINUX, _probe_docker, "install Docker (or Podman) and start its daemon"),
        Tool("sshd", _POSIX, _probe_sshd, "apt install openssh-server"),
        Tool("code-shim", _ALL, _probe_code_shim, "run via tests/system/pytest.sh (uv venv)"),
    )
}

_LINUX_APT_STEP = "Install system dependencies (Tauri + headless display)"

#: Where each tool comes from, per platform: the exact step name in
#: :data:`WORKFLOW`, or ``none: <why>`` when the runner image ships it (Docker
#: ships with the Ubuntu image too; its step brings the fixtures up). The one
#: table a provisioning fix starts from.
INSTALL_STEPS: dict[tuple[str, str], str] = {
    ("openbox", "linux"): _LINUX_APT_STEP,
    ("xprop", "linux"): _LINUX_APT_STEP,
    ("xdotool", "linux"): _LINUX_APT_STEP,
    ("xsettingsd", "linux"): _LINUX_APT_STEP,
    ("Xvfb", "linux"): _LINUX_APT_STEP,
    ("xclip", "linux"): _LINUX_APT_STEP,
    ("sway", "linux"): _LINUX_APT_STEP,
    ("wl-paste", "linux"): _LINUX_APT_STEP,
    ("wl-copy", "linux"): _LINUX_APT_STEP,
    ("socat", "linux"): _LINUX_APT_STEP,
    ("socat", "darwin"): "Install serial fixture dependency (socat)",
    ("docker", "linux"): "Bring up the Docker fixtures",
    ("sshd", "linux"): "none: openssh-server ships with the runner image",
    ("sshd", "darwin"): "none: /usr/sbin/sshd ships with macOS",
    ("code-shim", "linux"): "Setup uv",
    ("code-shim", "darwin"): "Setup uv",
    ("code-shim", "win32"): "Setup uv",
}

#: Lane-name prefix -> the job in :data:`WORKFLOW` that runs it (longest first).
LANE_JOBS: tuple[tuple[str, str], ...] = (
    ("scaled-display-", "display-grades"),
    ("display-", "display-grades"),
    ("os-input-", "system-integration"),
    ("wayland-", "system-integration"),
    ("bulk-", "system-integration"),
)


def platform_key(platform: str = sys.platform) -> str:
    if platform.startswith("linux"):
        return "linux"
    return platform


def fixture_needs(*tools: str) -> Callable:
    """Declare that a fixture needs ``tools``; put it *under* ``@pytest.fixture``.

    The fixture's function name is its fixture name, so every test whose
    fixture closure includes it counts the tools.
    """
    for tool in tools:
        if tool not in TOOLS:
            raise ValueError(f"unknown runner tool {tool!r} (known: {', '.join(sorted(TOOLS))})")

    def decorate(fn: Callable) -> Callable:
        FIXTURE_TOOLS[fn.__name__] = tuple(dict.fromkeys(FIXTURE_TOOLS.get(fn.__name__, ()) + tools))
        return fn

    return decorate


def mode_from_env(env: Mapping[str, str] = os.environ) -> str:
    value = env.get(MODE_ENV, "").strip().lower()
    if value in (_STRICT, _WARN, _OFF):
        return value
    if env.get("TERMIHUB_SKIP_GUARD_LANE", "").strip() or env.get("GITHUB_ACTIONS") == "true":
        return _STRICT
    return _WARN


def _statically_skipped(item) -> bool:
    """Whether the item's own ``skip`` / ``skipif`` marks already skip it."""
    try:
        from _pytest.skipping import evaluate_skip_marks
    except ImportError:  # pragma: no cover - pytest internals moved
        return False
    try:
        return evaluate_skip_marks(item) is not None
    except Exception:  # a broken condition errors in the test itself, not here
        return False


def item_tools(item, platform: str = sys.platform) -> set[str]:
    """The tools one collected item needs on ``platform``."""
    plat = platform_key(platform)
    wanted: set[str] = set()
    for mark in item.iter_markers(MARKER):
        only = mark.kwargs.get("platforms")
        if only is not None and plat not in {platform_key(p) for p in only}:
            continue
        for name in mark.args:
            if name not in TOOLS:
                raise ValueError(f"{item.nodeid}: unknown runner tool {name!r} in @{MARKER}")
            wanted.add(name)
    for fixture in getattr(item, "fixturenames", ()) or ():
        wanted.update(FIXTURE_TOOLS.get(fixture, ()))
    cls = getattr(item, "cls", None)
    if cls is not None and "code" in (getattr(cls, "external_app_shims", ()) or ()):
        wanted.add("code-shim")
    return {name for name in wanted if plat in TOOLS[name].platforms}


def requirements(
    items: Iterable, platform: str = sys.platform, skipped: Callable = _statically_skipped
) -> dict[str, list[str]]:
    """Tool name -> node ids of the selected items that need it."""
    needed: dict[str, list[str]] = {}
    for item in items:
        tools = item_tools(item, platform)
        if not tools or skipped(item):
            continue
        for name in tools:
            needed.setdefault(name, []).append(item.nodeid)
    return needed


def missing_tools(
    needed: Mapping[str, Sequence[str]], probes: Optional[Mapping[str, Callable]] = None
) -> dict[str, str]:
    """Probe each needed tool once; tool name -> why it is unusable."""
    missing: dict[str, str] = {}
    for name in sorted(needed):
        probe = (probes or {}).get(name) or TOOLS[name].probe
        try:
            reason = probe()
        except Exception as exc:  # a crashing probe is a missing tool, said plainly
            reason = f"probe failed: {exc}"
        if reason:
            missing[name] = reason
    return missing


def lane_label(lane: Optional[str], markexpr: str = "") -> str:
    if lane:
        return lane
    return f"local run (-m {markexpr!r})" if markexpr else "local run"


def _job_for(lane: Optional[str]) -> Optional[str]:
    for prefix, job in LANE_JOBS:
        if lane and lane.startswith(prefix):
            return job
    return None


def format_message(
    missing: Mapping[str, str],
    needed: Mapping[str, Sequence[str]],
    *,
    lane: Optional[str],
    markexpr: str = "",
    platform: str = sys.platform,
    strict: bool = True,
) -> str:
    """The one message a missing-tool session prints."""
    plat = platform_key(platform)
    job = _job_for(lane)
    lines = [
        f"termiHub tool preflight (#5340): {len(missing)} runner tool(s) missing for the "
        f"selected tests on lane {lane_label(lane, markexpr)} ({plat}): "
        + ", ".join(sorted(missing)),
    ]
    for name in sorted(missing):
        users = list(needed.get(name, ()))
        example = f", e.g. {users[0]}" if users else ""
        lines.append(f"  - {name}: {missing[name]}; needed by {len(users)} selected test(s){example}")
        step = INSTALL_STEPS.get((name, plat), "no workflow step for this platform")
        where = f"job {job!r}, " if job else ""
        lines.append(f"      should be installed by {WORKFLOW}: {where}step {step!r}")
        lines.append(f"      locally: {TOOLS[name].local_hint}")
    if strict:
        lines.append(
            "This is a provisioning error: the session stopped before any test ran, so nothing "
            f"was skipped or retried. Fix the step above (or {MODE_ENV}=warn to run anyway)."
        )
    else:
        lines.append(
            "Running anyway (warn mode): the tests that need these tools will skip or fail on "
            f"their own. {MODE_ENV}=strict stops the session instead."
        )
    return "\n".join(lines)


@dataclass(frozen=True)
class Outcome:
    """What one session's preflight found."""

    needed: dict[str, list[str]]
    missing: dict[str, str]
    strict: bool
    message: Optional[str]

    @property
    def stops_session(self) -> bool:
        return self.strict and bool(self.missing)

    def summary_lines(self) -> list[str]:
        if self.message:
            return self.message.splitlines()
        if not self.needed:
            return ["no runner tools needed by the selected tests"]
        checked = ", ".join(f"{name} ({len(ids)})" for name, ids in sorted(self.needed.items()))
        return [f"all present for the selected tests (tool: tests needing it): {checked}"]


def check_session(
    items: Iterable,
    *,
    env: Mapping[str, str] = os.environ,
    markexpr: str = "",
    platform: str = sys.platform,
    probes: Optional[Mapping[str, Callable]] = None,
) -> Optional[Outcome]:
    """Run the preflight for the selected ``items``; ``None`` when it is off."""
    mode = mode_from_env(env)
    if mode == _OFF:
        return None
    needed = requirements(items, platform)
    missing = missing_tools(needed, probes)
    strict = mode == _STRICT
    message = None
    if missing:
        lane = env.get("TERMIHUB_SKIP_GUARD_LANE", "").strip() or None
        message = format_message(
            missing, needed, lane=lane, markexpr=markexpr, platform=platform, strict=strict
        )
    return Outcome(needed, missing, strict, message)
