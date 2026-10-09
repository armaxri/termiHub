"""Script tests for ``scripts/internal/build-system-test-agent.sh`` (#4339, TIN2-005).

The test-hooks agent trusts the TEST-ONLY update-signing key, whose private half
is committed. It used to be built into ``target/<triple>/release/termihub-agent``,
the same path ``scripts/build.sh`` and ``scripts/build-agents.sh`` use for the
real agents that developers upload. These tests run the real script in a scratch
copy of the repo, with a fake ``cross`` on ``PATH``, and check that the binary
lands only in the dedicated target dir the harness stages from.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from termihub_harness import fixtures as fx

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="runs a bash script")

TARGET = "x86_64-unknown-linux-musl"

#: A fake ``cross``: records its env and args, then writes an "agent" that embeds
#: the test key into ``$CARGO_TARGET_DIR`` (cargo's default ``target`` if unset).
FAKE_CROSS = """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-}" "CROSS_CONFIG=${CROSS_CONFIG:-}" "$*" \\
    > "$FAKE_LOG"
target=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "--target" ]; then target="$2"; shift; fi
    shift
done
out="${CARGO_TARGET_DIR:-target}/$target/release"
mkdir -p "$out"
cp "$FAKE_AGENT" "$out/termihub-agent"
"""

#: A fake container engine that reports the local cross image as present.
FAKE_ENGINE = """#!/usr/bin/env bash
exit 0
"""


def _executable(path: Path, body: str) -> None:
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


@pytest.fixture
def fake_repo(tmp_path: Path) -> Path:
    """A scratch repo with the build script, its key probe and the key files."""
    root = tmp_path / "repo"
    for rel in (
        "scripts/internal/build-system-test-agent.sh",
        "scripts/internal/assert-no-test-signing-key.sh",
        "agent/keys/update-signing.pub.pem",
        "agent/keys/test-only/update-signing-TEST-ONLY.pub.pem",
    ):
        dest = root / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fx.REPO_ROOT / rel, dest)
    return root


def _run(fake_repo: Path, tmp_path: Path, *, local_image: bool) -> tuple[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _executable(bin_dir / "cross", FAKE_CROSS)
    _executable(bin_dir / "fake-engine", FAKE_ENGINE)
    agent = tmp_path / "agent-with-test-key"
    agent.write_bytes(b"\x7fELF " + b"\n".join(fx._test_only_key_lines()))
    log = tmp_path / "cross.log"
    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
    env["FAKE_LOG"] = str(log)
    env["FAKE_AGENT"] = str(agent)
    env["CROSS_CONTAINER_ENGINE"] = "fake-engine" if local_image else "no-such-engine-4339"
    env.pop("CARGO_TARGET_DIR", None)
    result = subprocess.run(
        ["bash", str(fake_repo / "scripts/internal/build-system-test-agent.sh"), "--target", TARGET],
        cwd=fake_repo,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout.strip().splitlines()[-1], log.read_text(encoding="utf-8")


@pytest.mark.parametrize("local_image", [False, True], ids=["stock-image", "local-image"])
def test_builds_into_the_dedicated_target_dir(
    fake_repo: Path, tmp_path: Path, local_image: bool
) -> None:
    printed, log = _run(fake_repo, tmp_path, local_image=local_image)

    expected = f"{fx.SYSTEM_TEST_AGENT_TARGET_DIR.as_posix()}/{TARGET}/release/termihub-agent"
    assert printed == expected
    assert (fake_repo / expected).is_file()
    assert f"CARGO_TARGET_DIR={fx.SYSTEM_TEST_AGENT_TARGET_DIR.as_posix()}" in log
    assert "--features test-hooks" in log
    assert ("CROSS_CONFIG=agent/Cross.toml" in log) is local_image
    assert not (fake_repo / "target" / TARGET).exists(), (
        "the test-key agent must never land in the release-agent output path"
    )


def test_harness_stages_from_the_path_the_script_builds() -> None:
    """``fixtures.system_test_agent_binary`` names the script's output path."""
    assert fx.system_test_agent_binary(TARGET) == (
        fx.REPO_ROOT / "target" / "system-test-agent" / TARGET / "release" / "termihub-agent"
    )
