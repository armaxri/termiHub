"""Machinery tests for the container-runtime fixture layer (no real runtime).

These run in the fast ``not integration`` group: they exercise the
Docker/Podman detection and the TCP readiness probe without bringing up any
container, so they pass on any machine.
"""

from __future__ import annotations

import socket
import subprocess
from types import SimpleNamespace

import pytest

from termihub_harness import (
    ContainerRuntimeUnavailable,
    container_runtime,
    reap_stale_fixtures,
    stale_fixture_containers,
    wait_for_port,
)
from termihub_harness import fixtures as fx


def test_container_runtime_returns_a_known_value_or_none(monkeypatch):
    """Auto-detection yields docker, podman, or None — never anything else."""
    monkeypatch.delenv("CONTAINER_CMD", raising=False)
    assert container_runtime() in (None, "docker", "podman")


def test_container_runtime_honors_a_bogus_override(monkeypatch):
    """A CONTAINER_CMD pointing at a missing binary resolves to unavailable."""
    monkeypatch.setenv("CONTAINER_CMD", "definitely-not-a-real-runtime-xyz")
    assert container_runtime() is None


def test_wait_for_port_returns_when_a_port_is_open():
    """An already-listening socket is detected immediately."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        host, port = server.getsockname()
        wait_for_port(host, port, timeout=2.0)  # must not raise


def test_wait_for_port_times_out_on_a_closed_port():
    """A closed port raises ContainerRuntimeUnavailable within the timeout."""
    # Reserve a port, then close it so nothing is listening there.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    with pytest.raises(ContainerRuntimeUnavailable):
        wait_for_port("127.0.0.1", closed_port, timeout=0.75)


# ── Pre-run stale-fixture reaper (finding TIN-011) ────────────────────────────
# The safety property under test is *scoping*: the reaper must select and remove
# only containers carrying THIS checkout's compose-project label, never a sibling
# checkout's or an unrelated workload's. These tests mock the container CLI so
# they assert the exact argv the reaper issues, on any machine (no real runtime).


class _FakeRun:
    """Records every ``subprocess.run`` argv and replays scripted results.

    ``ps`` calls return the queued stdout (the container-name listing); every
    other call (``rm``) returns success. Lets a test both stub what the runtime
    "sees" and assert exactly what the reaper asked it to do.
    """

    def __init__(self, ps_stdout: str = "") -> None:
        self.ps_stdout = ps_stdout
        self.calls: list[list[str]] = []

    def __call__(self, argv, *args, **kwargs):
        self.calls.append(list(argv))
        is_ps = "ps" in argv
        return SimpleNamespace(
            returncode=0,
            stdout=self.ps_stdout if is_ps else "",
            stderr="",
        )

    def call_matching(self, needle: str) -> list[str] | None:
        """The first recorded argv containing ``needle``, or ``None``."""
        return next((c for c in self.calls if needle in c), None)


def test_stale_fixture_containers_filters_on_the_compose_project_label(monkeypatch):
    """The listing query scopes to exactly this project via the compose label."""
    fake = _FakeRun(ps_stdout="termihub-test-6-ssh-password\ntermihub-test-6-telnet\n")
    monkeypatch.setattr(subprocess, "run", fake)

    names = stale_fixture_containers("docker", "termihub-test-6")

    assert names == ["termihub-test-6-ssh-password", "termihub-test-6-telnet"]
    ps = fake.call_matching("ps")
    assert ps is not None
    # Strict scoping: a label filter for THIS project, never a bare name glob.
    assert "--filter" in ps
    assert "label=com.docker.compose.project=termihub-test-6" in ps


def test_reap_removes_only_this_projects_containers(monkeypatch):
    """``rm -f`` targets exactly the listed names — never a broad prune."""
    fake = _FakeRun(ps_stdout="termihub-test-6-ssh-password\ntermihub-test-6-telnet\n")
    monkeypatch.setattr(subprocess, "run", fake)

    removed = reap_stale_fixtures("termihub-test-6", runtime="docker")

    assert removed == ["termihub-test-6-ssh-password", "termihub-test-6-telnet"]
    rm = fake.call_matching("rm")
    assert rm is not None
    # The remove names exactly the project's containers and nothing else — no
    # ``prune``, no ``--all``, no name wildcard that could hit a sibling checkout.
    assert rm == [
        "docker",
        "rm",
        "-f",
        "termihub-test-6-ssh-password",
        "termihub-test-6-telnet",
    ]
    assert "prune" not in rm


def test_reap_is_a_noop_when_no_runtime(monkeypatch):
    """No runtime → no removal, no error (returns an empty list)."""
    monkeypatch.setattr(fx, "container_runtime", lambda: None)
    fake = _FakeRun()
    monkeypatch.setattr(subprocess, "run", fake)

    assert reap_stale_fixtures("termihub-test-6") == []
    assert fake.calls == []  # nothing was shelled out at all


def test_reap_is_a_noop_when_nothing_stale(monkeypatch):
    """Zero matching containers → the reaper never issues a remove."""
    fake = _FakeRun(ps_stdout="")  # `ps` finds nothing
    monkeypatch.setattr(subprocess, "run", fake)

    assert reap_stale_fixtures("termihub-test-6", runtime="docker") == []
    assert fake.call_matching("rm") is None  # no remove attempted


def test_reap_once_runs_a_single_time_per_run(monkeypatch):
    """The per-process guard reaps on the first bring-up only, not on reuse."""
    monkeypatch.setattr(fx, "_reaped_projects", set())
    seen: list[str] = []
    monkeypatch.setattr(
        fx,
        "reap_stale_fixtures",
        lambda project, runtime=None: seen.append(project) or [],
    )

    fx._reap_stale_fixtures_once("docker", "termihub-test-6")
    fx._reap_stale_fixtures_once("docker", "termihub-test-6")  # warm reuse, same run

    assert seen == ["termihub-test-6"]  # reaped exactly once
