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
    stale_app_containers,
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


# ── App-backend container reaper (TIN-011 follow-up, #3049) ───────────────────
# The app's own ``termihub-<ts>-<pid>`` containers a crashed run leaks are reaped
# by the ``com.termihub.checkout`` label the backend stamps with this checkout's
# project — never by the shared ``termihub-`` name prefix, which would also match
# a sibling checkout's app containers.


class _FakeRunByLabel:
    """Records argv and returns per-``ps`` stdout keyed by the ``label=`` filter.

    Lets one reap issue distinct listings for the compose-project label and the
    checkout label, so a test can stub each independently and assert the reaper
    selects app containers by label — not by a ``termihub-*`` name glob.
    """

    def __init__(self, stdout_by_label: dict[str, str]) -> None:
        self.stdout_by_label = stdout_by_label
        self.calls: list[list[str]] = []

    def __call__(self, argv, *args, **kwargs):
        argv = list(argv)
        self.calls.append(argv)
        stdout = ""
        if "ps" in argv:
            label = next(
                (a.split("label=", 1)[1] for a in argv if a.startswith("label=")),
                "",
            )
            stdout = self.stdout_by_label.get(label, "")
        return SimpleNamespace(returncode=0, stdout=stdout, stderr="")

    def ps_calls(self) -> list[list[str]]:
        return [c for c in self.calls if "ps" in c]


def test_stale_app_containers_filters_on_the_checkout_label(monkeypatch):
    """App containers are listed by the checkout label, not a name glob."""
    fake = _FakeRunByLabel(
        {"com.termihub.checkout=termihub-test-6": "termihub-1712-9001\ntermihub-1713-9002\n"}
    )
    monkeypatch.setattr(subprocess, "run", fake)

    names = stale_app_containers("docker", "termihub-test-6")

    assert names == ["termihub-1712-9001", "termihub-1713-9002"]
    ps = fake.ps_calls()[0]
    # Strict scoping: a label filter for THIS checkout, never a bare name glob.
    assert "--filter" in ps
    assert "label=com.termihub.checkout=termihub-test-6" in ps
    assert not any(a.startswith("name=") for a in ps)
    assert not any("termihub-*" in a for a in ps)


def test_reap_removes_both_fixture_and_app_containers_label_scoped(monkeypatch):
    """The reap targets exactly the two label-scoped listings, nothing broader."""
    fake = _FakeRunByLabel(
        {
            "com.docker.compose.project=termihub-test-6": "termihub-test-6-ssh-password\n",
            "com.termihub.checkout=termihub-test-6": "termihub-1712-9001\n",
        }
    )
    monkeypatch.setattr(subprocess, "run", fake)

    removed = reap_stale_fixtures("termihub-test-6", runtime="docker")

    assert removed == ["termihub-test-6-ssh-password", "termihub-1712-9001"]
    # Both listings are label filters — the app containers are NEVER matched by a
    # ``termihub-*`` name glob (which would hit a sibling checkout's containers).
    for ps in fake.ps_calls():
        assert any(a.startswith("label=") for a in ps)
        assert not any(a.startswith("name=") for a in ps)
    rm = next((c for c in fake.calls if "rm" in c), None)
    assert rm is not None
    assert rm == [
        "docker",
        "rm",
        "-f",
        "termihub-test-6-ssh-password",
        "termihub-1712-9001",
    ]
    assert "prune" not in rm


def test_reap_deduplicates_a_container_seen_by_both_listings(monkeypatch):
    """A name returned by both listings is removed once, not twice."""
    fake = _FakeRunByLabel(
        {
            "com.docker.compose.project=termihub-test-6": "termihub-shared\n",
            "com.termihub.checkout=termihub-test-6": "termihub-shared\n",
        }
    )
    monkeypatch.setattr(subprocess, "run", fake)

    removed = reap_stale_fixtures("termihub-test-6", runtime="docker")

    assert removed == ["termihub-shared"]
    rm = next((c for c in fake.calls if "rm" in c), None)
    assert rm == ["docker", "rm", "-f", "termihub-shared"]
