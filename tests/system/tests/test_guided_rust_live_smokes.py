"""Guided-manual walks of ignored Rust live smokes that no CI runner can host (#5415).

Some ``#[ignore]``'d Rust tests are bound to a manual id (``manual: MT-…``, see
*Ignored tests: every ``#[ignore]`` is bound* in ``docs/testing.md``, #5177)
because they need a host CI does not have. Defining the id in the docs is not
enough: the release-gate manual run only walks what a ``manual``-marked test
names. This suite is where those ids get walked.

No app is launched. The harness checks the host's precondition, asks the
operator to provide it when it is missing, runs the cargo command from the
docs, and grades the output itself.

Covered: MT-RUST-01 (Podman machine routing on macOS).

Run with ``./pytest.sh --manual -k guided_rust_live_smokes -s``.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from termihub_harness import ManualUi
from termihub_harness.guided import (
    podman_machine_smoke_command,
    podman_machine_smoke_problem,
    running_podman_machines,
)

pytestmark = [pytest.mark.integration, pytest.mark.manual]

REPO_ROOT = Path(__file__).resolve().parents[3]

#: A cold ``termihub-core`` build with the docker feature can take a while.
_CARGO_TIMEOUT_S = 30 * 60


def _running_machines() -> list[str]:
    """Running Podman machines on this host (read-only ``podman machine list``)."""
    result = subprocess.run(
        ["podman", "machine", "list", "--format", "json"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        pytest.fail(f"`podman machine list` failed: {result.stderr.strip()}")
    return running_podman_machines(result.stdout)


class TestGuidedRustLiveSmokes(ManualUi):
    """The harness runs and grades the test; the operator provides the host."""

    @pytest.mark.manual(platforms=["macos"])
    def test_podman_machine_routing_on_macos(self):
        """MT-RUST-01: explicit Podman reaches a running Podman machine on macOS.

        Runs ``connect_to_runtime_reaches_macos_podman_machine`` (ignored in
        ``core/src/backends/docker/mod.rs``, #1622). It resolves the machine's
        ``-api.sock`` socket and reaches the Podman daemon behind it. If no
        machine is running, the operator starts one; the harness never starts,
        stops or changes a Podman machine itself.
        """
        if shutil.which("podman") is None:
            self.manual_step(
                "Install Podman (https://podman.io) and create a machine with "
                "`podman machine init`, then start it with `podman machine start`.",
                "`podman` is on PATH and `podman machine list` shows a running machine",
            )
            assert shutil.which("podman") is not None, "podman is still not on PATH"

        machines = _running_machines()
        if not machines:
            self.manual_step(
                "No Podman machine is running. In another terminal run "
                "`podman machine start` (after `podman machine init` if you have none).",
                "`podman machine list` shows a machine as currently running",
            )
            machines = _running_machines()
        assert machines, "no Podman machine is running"
        print(f"\n[MT-RUST-01] running Podman machine(s): {', '.join(machines)}")

        command = podman_machine_smoke_command()
        print(f"[MT-RUST-01] running from {REPO_ROOT}: {' '.join(command)}")
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=_CARGO_TIMEOUT_S,
            check=False,
        )
        print(result.stdout)
        problem = podman_machine_smoke_problem(result.stdout)
        assert result.returncode == 0 and problem is None, (
            f"MT-RUST-01 failed (cargo exit {result.returncode}): "
            f"{problem or 'cargo test exited non-zero'}"
        )
