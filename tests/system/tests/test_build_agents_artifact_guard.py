"""Script tests for the local agent builds' test-artifact guard (#4554).

``scripts/build-agents.sh`` and ``scripts/build.sh`` leave the agents they build
in ``target/<triple>/<profile>/``, the path developers upload. An agent built
with the ``test-hooks`` feature trusts the TEST-ONLY update-signing key, whose
private half is committed, so both scripts now run
``scripts/internal/assert-no-test-signing-key.sh`` (and, outside ``--dev``,
``scripts/internal/assert-no-agent-test-hooks.sh``) on every agent they build
and fail the target when either fires. A ``--features test-hooks`` build is the
system-test agent and is not checked.

These tests run the real scripts in a scratch copy of the repo with fake
``cross``/``cargo``/``rustup`` on ``PATH``: the fakes "build" an agent by copying
a prepared file that does or does not embed the key / a test-hook env name.
The PowerShell twin that ``build-agents.cmd`` uses is checked against the same
files when ``pwsh`` is available.
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from termihub_harness import fixtures as fx

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="runs bash scripts")

TARGET = "x86_64-unknown-linux-musl"
TARGET2 = "aarch64-unknown-linux-musl"

#: Files the scripts under test read, copied into the scratch repo.
REPO_FILES = (
    "scripts/build-agents.sh",
    "scripts/build.sh",
    "scripts/internal/assert-no-test-signing-key.sh",
    "scripts/internal/assert-no-agent-test-hooks.sh",
    "scripts/internal/assert-no-agent-test-artifacts.ps1",
    "agent/keys/update-signing.pub.pem",
    "agent/keys/test-only/update-signing-TEST-ONLY.pub.pem",
    "agent/src/test_parent_watchdog.rs",
    "agent/src/io/tcp.rs",
    "agent/src/update/test_hook.rs",
)

#: A fake ``cross``/``cargo build``: copies ``$FAKE_AGENT`` to where cargo would
#: leave the agent (``$CARGO_TARGET_DIR`` or ``target``, release or debug).
FAKE_BUILD = """#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_LOG"
target=""
profile=debug
while [ "$#" -gt 0 ]; do
    case "$1" in
    --target) target="$2"; shift ;;
    --release) profile=release ;;
    esac
    shift
done
out="${CARGO_TARGET_DIR:-target}/$target/$profile"
mkdir -p "$out"
cp "$FAKE_AGENT" "$out/termihub-agent"
"""

#: A fake ``rustup`` that reports both test targets installed.
FAKE_RUSTUP = f"""#!/usr/bin/env bash
printf '%s\\n' {TARGET} {TARGET2}
"""

FAKE_NOOP = """#!/usr/bin/env bash
exit 0
"""

#: build.sh's agent section only runs on macOS.
FAKE_UNAME = """#!/usr/bin/env bash
echo Darwin
"""


def _executable(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _test_hook_env_name() -> bytes:
    """The parent-death watchdog's env name, read from its Rust definition."""
    src = (fx.REPO_ROOT / "agent/src/test_parent_watchdog.rs").read_text(encoding="utf-8")
    match = re.search(r'^pub const PARENT_PID_ENV: &str = "(.*)";$', src, re.MULTILINE)
    assert match, "PARENT_PID_ENV definition moved"
    return match.group(1).encode()


#: Agent contents: clean, embedding the TEST-ONLY key, or a test-hook env name.
AGENTS = {
    "clean": lambda: b"\x7fELF a release agent\x00",
    "test-key": lambda: b"\x7fELF " + b"\n".join(fx._test_only_key_lines()),
    "test-hooks": lambda: b"\x7fELF " + _test_hook_env_name() + b"\x00",
}


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """A scratch git repo holding the scripts under test and what they read."""
    root = tmp_path / "repo"
    for rel in REPO_FILES:
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fx.REPO_ROOT / rel, dest)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    return root


def _env(tmp_path: Path, agent: str) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    for name in ("cross", "cargo"):
        _executable(bin_dir / name, FAKE_BUILD)
    _executable(bin_dir / "rustup", FAKE_RUSTUP)
    _executable(bin_dir / "fake-engine", FAKE_NOOP)
    agent_file = tmp_path / f"agent-{agent}"
    agent_file.write_bytes(AGENTS[agent]())
    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["FAKE_LOG"] = str(tmp_path / "build.log")
    env["FAKE_AGENT"] = str(agent_file)
    env["CROSS_CONTAINER_ENGINE"] = "fake-engine"
    env.pop("CARGO_TARGET_DIR", None)
    return env


def _build_agents(
    fake_repo: Path, tmp_path: Path, agent: str, *args: str
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(fake_repo / "scripts/build-agents.sh"), *args],
        cwd=fake_repo,
        env=_env(tmp_path, agent),
        capture_output=True,
        text=True,
        timeout=120,
    )


def _output(result: subprocess.CompletedProcess[str]) -> str:
    return result.stdout + result.stderr


# --- build-agents.sh ---------------------------------------------------------


def test_release_build_embedding_the_test_key_fails(fake_repo: Path, tmp_path: Path) -> None:
    binary = fake_repo / "target" / TARGET / "release" / "termihub-agent"
    binary.parent.mkdir(parents=True)
    # Sidecars from an earlier good build must not vouch for the new bytes.
    (binary.parent / "termihub-agent.sha256").write_text("stale  termihub-agent\n")
    (binary.parent / "termihub-agent.sig").write_text("stale")

    result = _build_agents(fake_repo, tmp_path, "test-key", "--targets", TARGET)

    out = _output(result)
    assert result.returncode == 1, out
    assert "embeds the TEST-ONLY update-signing key" in out
    assert f"FAIL  {TARGET}  (embeds test-only artifacts)" in out
    assert "Built: 0 | Failed: 1" in out
    assert not (binary.parent / "termihub-agent.sha256").exists()
    assert not (binary.parent / "termihub-agent.sig").exists()


def test_release_build_with_test_hooks_compiled_in_fails(fake_repo: Path, tmp_path: Path) -> None:
    result = _build_agents(fake_repo, tmp_path, "test-hooks", "--targets", TARGET)

    out = _output(result)
    assert result.returncode == 1, out
    assert "contains the test-hook env var" in out
    assert "Built: 0 | Failed: 1" in out


def test_parallel_build_guards_every_target(fake_repo: Path, tmp_path: Path) -> None:
    result = _build_agents(fake_repo, tmp_path, "test-key", "--targets", f"{TARGET},{TARGET2}")

    out = _output(result)
    assert result.returncode == 1, out
    assert f"FAIL  {TARGET}  (embeds test-only artifacts)" in out
    assert f"FAIL  {TARGET2}  (embeds test-only artifacts)" in out
    assert "Built: 0 | Failed: 2" in out


@pytest.mark.parametrize("features", ["test-hooks", "foo,test-hooks", "termihub-agent/test-hooks"])
def test_test_hooks_feature_build_is_not_checked(
    fake_repo: Path, tmp_path: Path, features: str
) -> None:
    result = _build_agents(
        fake_repo, tmp_path, "test-key", "--targets", TARGET, "--features", features
    )

    out = _output(result)
    assert result.returncode == 0, out
    assert "skipping the test-only artifact guard" in out
    assert "ok: " not in out, "the guard ran on a test-hooks build"
    assert "Built: 1 | Failed: 0" in out
    assert (fake_repo / "target" / TARGET / "release" / "termihub-agent.sha256").is_file()


def test_clean_release_build_passes_both_guards(fake_repo: Path, tmp_path: Path) -> None:
    result = _build_agents(fake_repo, tmp_path, "clean", "--targets", TARGET)

    out = _output(result)
    assert result.returncode == 0, out
    assert "does not embed the TEST-ONLY update-signing key" in out
    assert "contains no env-armed agent test hooks" in out
    assert "Built: 1 | Failed: 0" in out


def test_dev_build_skips_only_the_test_hook_guard(fake_repo: Path, tmp_path: Path) -> None:
    """A debug agent always carries the test hooks; the key guard still applies."""
    hooks = _build_agents(fake_repo, tmp_path, "test-hooks", "--targets", TARGET, "--dev")
    assert hooks.returncode == 0, _output(hooks)
    assert "contains no env-armed agent test hooks" not in _output(hooks)
    assert (fake_repo / "target" / TARGET / "debug" / "termihub-agent.sha256").is_file()

    shutil.rmtree(tmp_path / "bin")
    key = _build_agents(fake_repo, tmp_path, "test-key", "--targets", TARGET, "--dev")
    assert key.returncode == 1, _output(key)
    assert "embeds the TEST-ONLY update-signing key" in _output(key)


# --- build.sh (agent section) ------------------------------------------------


def _build_sh(fake_repo: Path, tmp_path: Path, agent: str) -> subprocess.CompletedProcess[str]:
    env = _env(tmp_path, agent)
    bin_dir = tmp_path / "bin"
    # Desktop-bundle steps are out of scope: stub them out.
    for name in ("pnpm", "cargo-about", "x86_64-linux-musl-gcc", "aarch64-linux-musl-gcc"):
        _executable(bin_dir / name, FAKE_NOOP)
    _executable(bin_dir / "uname", FAKE_UNAME)
    for name in ("build-rdp-sidecar.sh", "build-plugin-runner.sh"):
        _executable(fake_repo / "scripts" / name, FAKE_NOOP)
    (fake_repo / "node_modules").mkdir()
    return subprocess.run(
        ["bash", str(fake_repo / "scripts/build.sh")],
        cwd=fake_repo,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.mark.parametrize("agent", ["test-key", "test-hooks"])
def test_build_sh_fails_on_an_agent_with_test_artifacts(
    fake_repo: Path, tmp_path: Path, agent: str
) -> None:
    result = _build_sh(fake_repo, tmp_path, agent)

    out = _output(result)
    assert result.returncode == 1, out
    assert "embeds test-only artifacts and must never be uploaded" in out
    assert "2 agent binary(ies) failed the test-only artifact guard" in out


def test_build_sh_passes_clean_agents(fake_repo: Path, tmp_path: Path) -> None:
    result = _build_sh(fake_repo, tmp_path, "clean")

    out = _output(result)
    assert result.returncode == 0, out
    for target in (TARGET, TARGET2):
        assert f"-> target/{target}/release/termihub-agent" in out


# --- assert-no-agent-test-artifacts.ps1 (build-agents.cmd's guard) -----------


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="needs pwsh")
@pytest.mark.parametrize(
    ("agent", "skip_hooks", "expected"),
    [
        ("clean", False, 0),
        ("test-key", False, 1),
        ("test-key", True, 1),
        ("test-hooks", False, 1),
        ("test-hooks", True, 0),
    ],
)
def test_powershell_guard_matches_the_bash_guards(
    fake_repo: Path, tmp_path: Path, agent: str, skip_hooks: bool, expected: int
) -> None:
    binary = tmp_path / f"agent-{agent}"
    binary.write_bytes(AGENTS[agent]())
    args = ["-SkipTestHooks"] if skip_hooks else []
    result = subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(fake_repo / "scripts/internal/assert-no-agent-test-artifacts.ps1"),
            "-Binary",
            str(binary),
            *args,
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == expected, _output(result)

    bash_rc = max(
        subprocess.run(
            ["bash", str(fake_repo / "scripts/internal" / guard), str(binary)],
            capture_output=True,
            timeout=60,
        ).returncode
        for guard in ("assert-no-test-signing-key.sh",)
        + (() if skip_hooks else ("assert-no-agent-test-hooks.sh",))
    )
    assert bash_rc == expected


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="needs pwsh")
def test_powershell_guard_fails_closed_when_a_definition_moves(
    fake_repo: Path, tmp_path: Path
) -> None:
    (fake_repo / "agent/src/update/test_hook.rs").write_text("// moved\n", encoding="utf-8")
    binary = tmp_path / "agent"
    binary.write_bytes(AGENTS["clean"]())
    result = subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(fake_repo / "scripts/internal/assert-no-agent-test-artifacts.ps1"),
            "-Binary",
            str(binary),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 2, _output(result)
    assert "test-hook env name not found" in result.stderr
