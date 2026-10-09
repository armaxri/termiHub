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


def _closed_port() -> int:
    """A port nothing listens on (reserved, then released)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_wait_for_port_times_out_on_a_closed_port(monkeypatch):
    """Off CI a closed port raises ContainerRuntimeUnavailable (a skip)."""
    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(ContainerRuntimeUnavailable):
        wait_for_port("127.0.0.1", _closed_port(), timeout=0.75)


# ── Strict-mode readiness timeouts (#4315, WA-CI2-003) ────────────────────────
# A fixture that starts but never opens its port / greets / answers RDP, or a
# compose call that times out, ran against a working runtime: under CI it must
# error (ComposeFixtureFailed escapes the suites' skip handlers), not skip.
def test_wait_for_port_timeout_on_ci_fails_instead_of_skipping(monkeypatch):
    monkeypatch.setenv("CI", "true")
    with pytest.raises(fx.ComposeFixtureFailed, match="did not become reachable"):
        wait_for_port("127.0.0.1", _closed_port(), timeout=0.5)


def test_wait_for_banner_timeout_on_ci_fails_instead_of_skipping(monkeypatch):
    monkeypatch.setenv("CI", "true")
    with pytest.raises(fx.ComposeFixtureFailed, match="did not greet"):
        fx.wait_for_banner("127.0.0.1", _closed_port(), b"RFB ", timeout=0.5)


def test_wait_for_banner_timeout_off_ci_still_skips(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(ContainerRuntimeUnavailable, match="did not greet"):
        fx.wait_for_banner("127.0.0.1", _closed_port(), b"RFB ", timeout=0.5)


def test_wait_for_rdp_timeout_on_ci_fails_instead_of_skipping(monkeypatch):
    monkeypatch.setenv("CI", "true")
    with pytest.raises(fx.ComposeFixtureFailed, match="RDP connection request"):
        fx.wait_for_rdp("127.0.0.1", _closed_port(), timeout=0.5)


def test_wait_for_rdp_timeout_off_ci_still_skips(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(ContainerRuntimeUnavailable, match="RDP connection request"):
        fx.wait_for_rdp("127.0.0.1", _closed_port(), timeout=0.5)


def _timing_out_run(cmd, **kwargs):
    raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 5.0), stderr="building...")


def test_compose_timeout_on_ci_fails_instead_of_skipping(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(subprocess, "run", _timing_out_run)
    with pytest.raises(fx.ComposeFixtureFailed, match="timed out after"):
        _run_compose()


def test_compose_timeout_off_ci_still_skips(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setattr(subprocess, "run", _timing_out_run)
    with pytest.raises(ContainerRuntimeUnavailable, match="timed out after"):
        _run_compose()


def test_container_control_timeout_on_ci_fails(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(fx, "container_runtime", lambda: "docker")
    control = fx.ContainerControl("vnc-server")
    monkeypatch.setattr(subprocess, "run", _timing_out_run)
    with pytest.raises(fx.ComposeFixtureFailed, match="timed out after"):
        control.start()


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


# ── Compose-failure classification (#4103) ────────────────────────────────────
# A failed ``compose`` run used to map to ContainerRuntimeUnavailable (→ skip)
# unconditionally, so a container-name conflict silently skipped ~100 Linux
# suites for days. Now only "no usable runtime" output skips; a real compose
# failure raises ComposeFixtureFailed (→ the test errors) whenever CI is set.

#: Mirrors the stderr seen in the nightly runs cited by #4103 (the workflow brought
#: the fixtures up under compose project ``docker``; the harness used ``-p termihub``).
_NAME_CONFLICT_STDERR = """\
 Container termihub-ssh-password  Creating
 Container termihub-ssh-keys  Creating
Error response from daemon: Conflict. The container name "/termihub-ssh-keys" is \
already in use by container "3f1c0a9e7b2d". You have to remove (or rename) that \
container to be able to reuse that name.
"""

_NO_DAEMON_STDERR = (
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. "
    "Is the docker daemon running?\n"
)

_NO_COMPOSE_PLUGIN_STDERR = "docker: 'compose' is not a docker command.\nSee 'docker --help'\n"

_PODMAN_NO_PROVIDER_STDERR = (
    "Error: looking up compose provider failed\n"
    "7 errors occurred:\n\t* exec: \"docker-compose\": executable file not found in $PATH\n"
)

_BAD_COMPOSE_FILE_STDERR = (
    "validating tests/docker/docker-compose.yml: services.ssh-keys "
    "additional properties 'bogus' not allowed\n"
)


def _failing_run(stderr: str, *, stdout: str = "", returncode: int = 1):
    """A ``subprocess.run`` stand-in that fails like ``check=True`` would."""

    def run(cmd, **_kwargs):
        raise subprocess.CalledProcessError(returncode, cmd, output=stdout, stderr=stderr)

    return run


def _run_compose():
    fx.ComposeFixture._run_compose(
        ["docker", "compose", "up", "-d", "ssh-keys"],
        ["ssh-keys"],
        env={},
        timeout=5.0,
        action="up",
    )


@pytest.mark.parametrize(
    "stderr",
    [
        _NO_DAEMON_STDERR,
        _NO_COMPOSE_PLUGIN_STDERR,
        _PODMAN_NO_PROVIDER_STDERR,
        "no matching manifest for windows/amd64 10.0.20348 in the manifest list entries\n",
    ],
    ids=["no-daemon", "no-compose-plugin", "podman-no-provider", "windows-daemon"],
)
def test_runtime_unavailable_output_is_classified_as_skip(stderr):
    assert fx.is_runtime_unavailable_output(stderr)


@pytest.mark.parametrize(
    "stderr",
    [_NAME_CONFLICT_STDERR, _BAD_COMPOSE_FILE_STDERR, "", None],
    ids=["name-conflict", "bad-compose-file", "empty", "none"],
)
def test_real_compose_failure_output_is_not_classified_as_skip(stderr):
    assert not fx.is_runtime_unavailable_output(stderr)


def test_name_conflict_on_ci_fails_instead_of_skipping(monkeypatch):
    """The #4103 regression: a name conflict under CI must error, not skip."""
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(subprocess, "run", _failing_run(_NAME_CONFLICT_STDERR))
    with pytest.raises(fx.ComposeFixtureFailed, match="is already in use"):
        _run_compose()


def test_compose_fixture_failed_escapes_a_skip_handler():
    """Not a ContainerRuntimeUnavailable subclass, so the suites' skip handlers
    (``except ContainerRuntimeUnavailable: pytest.skip``) let it through."""
    assert not issubclass(fx.ComposeFixtureFailed, ContainerRuntimeUnavailable)


def test_bad_compose_file_on_ci_fails(monkeypatch):
    monkeypatch.setenv("CI", "1")
    monkeypatch.setattr(subprocess, "run", _failing_run(_BAD_COMPOSE_FILE_STDERR))
    with pytest.raises(fx.ComposeFixtureFailed):
        _run_compose()


def test_no_daemon_on_ci_still_skips(monkeypatch):
    """A machine without a reachable runtime skips cleanly even on CI."""
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(subprocess, "run", _failing_run(_NO_DAEMON_STDERR))
    with pytest.raises(ContainerRuntimeUnavailable, match="Docker daemon"):
        _run_compose()


def test_runtime_marker_on_stdout_is_honored(monkeypatch):
    """Some providers print the connection error on stdout, not stderr."""
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(subprocess, "run", _failing_run("", stdout=_NO_DAEMON_STDERR))
    with pytest.raises(ContainerRuntimeUnavailable):
        _run_compose()


@pytest.mark.parametrize("ci_value", [None, "", "0", "false"], ids=["unset", "empty", "0", "false"])
def test_name_conflict_off_ci_degrades_to_skip(monkeypatch, ci_value):
    """Off CI a real compose failure keeps the old skip behaviour."""
    if ci_value is None:
        monkeypatch.delenv("CI", raising=False)
    else:
        monkeypatch.setenv("CI", ci_value)
    monkeypatch.setattr(subprocess, "run", _failing_run(_NAME_CONFLICT_STDERR))
    with pytest.raises(ContainerRuntimeUnavailable, match="is already in use"):
        _run_compose()


def test_compose_fixture_failed_is_exported():
    import termihub_harness

    assert termihub_harness.ComposeFixtureFailed is fx.ComposeFixtureFailed


def _info_run(os_type: str, *, returncode: int = 0):
    def run(cmd, **_kwargs):
        assert cmd[1:] == ["info", "--format", "{{.OSType}}"]
        return SimpleNamespace(returncode=returncode, stdout=f"{os_type}\n", stderr="")

    return run


def test_docker_os_type_reads_the_daemon_os(monkeypatch):
    monkeypatch.setattr(subprocess, "run", _info_run("windows"))
    assert fx._docker_os_type("docker") == "windows"


def test_docker_os_type_is_none_for_podman(monkeypatch):
    def run(*_args, **_kwargs):
        raise AssertionError("podman must not be queried for OSType")

    monkeypatch.setattr(subprocess, "run", run)
    assert fx._docker_os_type("podman") is None


def test_docker_os_type_is_none_on_query_error(monkeypatch):
    monkeypatch.setattr(subprocess, "run", _info_run("", returncode=1))
    assert fx._docker_os_type("docker") is None


def test_ensure_skips_on_a_windows_container_daemon_even_on_ci(monkeypatch):
    """The hosted Windows runner has a reachable daemon that cannot run the Linux
    fixtures: that is an environment gap and must still skip under CI."""
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(fx, "container_runtime", lambda: "docker")
    monkeypatch.setattr(fx, "_docker_os_type", lambda _runtime: "windows")

    def no_compose(*_args, **_kwargs):
        raise AssertionError("compose must not run against a Windows daemon")

    monkeypatch.setattr(fx, "_reap_stale_fixtures_once", no_compose)
    monkeypatch.setattr(fx.ComposeFixture, "_run_compose", staticmethod(no_compose))
    with pytest.raises(ContainerRuntimeUnavailable, match="windows containers"):
        fx.ComposeFixture().ensure("ssh-keys")


# ── Adopting fixtures brought up under another compose project (#4017) ──────────
# The 2026-10-06 nightly: the workflow (main's copy) bulk-started the fixtures
# with a bare ``docker compose up`` (project ``docker``, from the directory), and
# every harness ``compose -p termihub up`` then failed on the fixed container
# names. The harness now detects that shape and adopts the other project.


def _write_compose(tmp_path):
    compose = tmp_path / "tests" / "docker" / "docker-compose.yml"
    compose.parent.mkdir(parents=True)
    compose.write_text(
        "services:\n"
        "  ssh-password:\n"
        "    container_name: ${TERMIHUB_TEST_PROJECT:-termihub}-ssh-password\n"
        "  telnet-server:\n"
        "    container_name: ${TERMIHUB_TEST_PROJECT:-termihub}-telnet  # trailing\n"
        "networks:\n"
        "  test-net:\n"
        "    name: ${TERMIHUB_TEST_PROJECT:-termihub}-test-net\n"
        "  # name: ${TERMIHUB_TEST_PROJECT:-termihub}-commented-out\n",
        encoding="utf-8",
    )
    return compose


def test_fixed_resource_names_reads_containers_and_networks(tmp_path):
    compose = _write_compose(tmp_path)
    containers, networks = fx.fixed_resource_names(compose, "termihub-test-3")
    assert containers == {"termihub-test-3-ssh-password", "termihub-test-3-telnet"}
    assert networks == {"termihub-test-3-test-net"}


def test_fixed_resource_names_covers_the_real_compose_file():
    containers, networks = fx.fixed_resource_names(fx.COMPOSE_FILE, "termihub")
    assert "termihub-ssh-password" in containers
    assert "termihub-remote-agent" in containers
    assert networks == {"termihub-test-net", "termihub-jumphost-net"}


def test_fixed_resource_names_of_a_missing_file_is_empty(tmp_path):
    assert fx.fixed_resource_names(tmp_path / "nope.yml", "termihub") == (set(), set())


def test_foreign_owner_is_adopted_when_one_project_owns_everything(tmp_path):
    compose = _write_compose(tmp_path)
    containers = {
        "termihub-ssh-password": ("docker", str(compose)),
        "termihub-telnet": ("docker", str(compose)),
    }
    networks = {"termihub-test-net": "docker"}
    assert fx.foreign_compose_owner("termihub", containers, networks, compose) == "docker"


def test_foreign_owner_of_only_the_network_is_adopted(tmp_path):
    """A leftover network alone also blocks a clean bring-up under our name."""
    compose = _write_compose(tmp_path)
    assert fx.foreign_compose_owner("termihub", {}, {"termihub-test-net": "docker"}, compose) == (
        "docker"
    )


@pytest.mark.parametrize(
    "containers, networks",
    [
        ({}, {}),
        ({"termihub-ssh-password": ("termihub", "")}, {"termihub-test-net": "termihub"}),
    ],
    ids=["nothing-present", "already-ours"],
)
def test_no_adoption_when_nothing_foreign(tmp_path, containers, networks):
    compose = _write_compose(tmp_path)
    assert fx.foreign_compose_owner("termihub", containers, networks, compose) is None


@pytest.mark.parametrize(
    "containers, networks",
    [
        # A hand-made (non-compose) container squatting a fixed name.
        ({"termihub-ssh-password": ("", "")}, {}),
        # Two different owners.
        ({"termihub-ssh-password": ("docker", "")}, {"termihub-test-net": "other"}),
        # A mix with our own project: adopting would just move the conflict.
        ({"termihub-ssh-password": ("docker", "")}, {"termihub-test-net": "termihub"}),
    ],
    ids=["non-compose-container", "two-owners", "mixed-with-ours"],
)
def test_no_adoption_when_ambiguous(tmp_path, containers, networks):
    compose = _write_compose(tmp_path)
    assert fx.foreign_compose_owner("termihub", containers, networks, compose) is None


def test_no_adoption_from_a_different_compose_file(tmp_path):
    compose = _write_compose(tmp_path)
    other = tmp_path / "elsewhere" / "docker-compose.yml"
    containers = {"termihub-ssh-password": ("docker", str(other))}
    assert fx.foreign_compose_owner("termihub", containers, {}, compose) is None


def test_adoption_matches_a_config_file_among_several(tmp_path):
    compose = _write_compose(tmp_path)
    labels = f"/x/override.yml,{compose}"
    containers = {"termihub-ssh-password": ("docker", labels)}
    assert fx.foreign_compose_owner("termihub", containers, {}, compose) == "docker"


def _docker_listing(ps_stdout: str, network_stdout: str, *, returncode: int = 0):
    calls: list[list[str]] = []

    def run(cmd, **_kwargs):
        calls.append(list(cmd))
        out = ps_stdout if cmd[1] == "ps" else network_stdout
        return SimpleNamespace(returncode=returncode, stdout=out, stderr="")

    return run, calls


def test_compose_run_project_adopts_the_workflow_bring_up(tmp_path, monkeypatch, capsys):
    """The exact nightly shape: fixtures up under ``docker``, a sibling checkout's
    under its own name, an unrelated container — only ours are considered."""
    compose = _write_compose(tmp_path)
    monkeypatch.setattr(fx, "_compose_run_projects", {})
    ps = (
        f"termihub-ssh-password\tdocker\t{compose}\n"
        f"termihub-telnet\tdocker\t{compose}\n"
        f"termihub-test-6-ssh-password\ttermihub-test-6\t/other/docker-compose.yml\n"
        "unrelated\t\t\n"
    )
    networks = "bridge\t\ntermihub-test-net\tdocker\ntermihub-test-6-test-net\ttermihub-test-6\n"
    run, calls = _docker_listing(ps, networks)
    monkeypatch.setattr(subprocess, "run", run)

    assert fx.compose_run_project("docker", "termihub", compose) == "docker"
    assert "adopting compose project 'docker'" in capsys.readouterr().err
    # Cached: a second ensure() in the same process does not re-query.
    assert fx.compose_run_project("docker", "termihub", compose) == "docker"
    assert len(calls) == 2
    ps_call = next(c for c in calls if c[1] == "ps")
    assert ps_call[:3] == ["docker", "ps", "-a"]
    assert '{{.Label "com.docker.compose.project"}}' in ps_call[-1]


def test_compose_run_project_keeps_our_project_by_default(tmp_path, monkeypatch):
    compose = _write_compose(tmp_path)
    monkeypatch.setattr(fx, "_compose_run_projects", {})
    run, _ = _docker_listing("termihub-test-6-ssh-password\ttermihub-test-6\t\n", "")
    monkeypatch.setattr(subprocess, "run", run)
    assert fx.compose_run_project("docker", "termihub", compose) == "termihub"


def test_compose_run_project_keeps_our_project_when_the_query_fails(tmp_path, monkeypatch):
    """E.g. a Podman CLI without ``.Label`` template support: adopt nothing."""
    compose = _write_compose(tmp_path)
    monkeypatch.setattr(fx, "_compose_run_projects", {})
    run, _ = _docker_listing("garbage", "garbage", returncode=125)
    monkeypatch.setattr(subprocess, "run", run)
    assert fx.compose_run_project("podman", "termihub", compose) == "termihub"


def test_ensure_runs_compose_under_the_adopted_project(monkeypatch):
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(fx, "container_runtime", lambda: "docker")
    monkeypatch.setattr(fx, "_docker_os_type", lambda _runtime: "linux")
    monkeypatch.setattr(fx, "_reap_stale_fixtures_once", lambda *_a: None)
    monkeypatch.setattr(fx, "compose_run_project", lambda *_a: "docker")
    seen: list[list[str]] = []

    def record(cmd, *_args, **_kwargs):
        seen.append(cmd)

    monkeypatch.setattr(fx.ComposeFixture, "_run_compose", staticmethod(record))
    fx.ComposeFixture().ensure("ssh-password")
    assert seen and seen[0][:4] == ["docker", "compose", "-p", "docker"]
    assert seen[0][-3:] == ["up", "-d", "ssh-password"]


# ── Deployed-agent binary staging (#4092) ──────────────────────────────────────


def _test_key_body() -> bytes:
    return b"\n".join(fx._test_only_key_lines())


@pytest.fixture
def agent_tree(tmp_path, monkeypatch):
    """A fake repo root for :func:`stage_remote_agent_binary`: a Linux docker
    runtime, an x86_64 musl target, and a recorder in place of the build."""
    monkeypatch.setattr(fx, "REPO_ROOT", tmp_path)
    context = tmp_path / "context"
    context.mkdir()
    monkeypatch.setattr(fx, "_REMOTE_AGENT_BUILD_CONTEXT", context)
    monkeypatch.setattr(fx, "_agent_build_verified", set())
    monkeypatch.setattr(fx, "container_runtime", lambda: "docker")
    monkeypatch.setattr(fx, "_docker_os_type", lambda _runtime: "linux")
    monkeypatch.setattr(fx, "_container_musl_target", lambda: "x86_64-unknown-linux-musl")
    built = tmp_path / "target" / "x86_64-unknown-linux-musl" / "release" / "termihub-agent"
    built.parent.mkdir(parents=True)
    calls: list[list[str]] = []

    def build(cmd, **_kwargs):
        calls.append(list(cmd))
        built.write_bytes(b"\x7fELF fresh " + _test_key_body())
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(subprocess, "run", build)
    return SimpleNamespace(built=built, calls=calls, context=context)


def test_embeds_test_signing_key_detects_a_test_hooks_build(tmp_path):
    with_key = tmp_path / "with"
    with_key.write_bytes(b"\x00\x01prefix" + _test_key_body() + b"suffix\xff")
    without = tmp_path / "without"
    without.write_bytes(b"\x00\x01a release agent with only the real key\xff")
    assert fx.embeds_test_signing_key(with_key)
    assert not fx.embeds_test_signing_key(without)


def test_stale_build_without_the_test_key_is_rebuilt_off_ci(agent_tree, monkeypatch):
    """The #4092 stale-binary case: a reused non-test-hooks build would fail the
    real swap at AGT-005, so it is rebuilt instead."""
    monkeypatch.delenv("CI", raising=False)
    agent_tree.built.write_bytes(b"\x7fELF stale release build")
    staged = fx.stage_remote_agent_binary()
    assert len(agent_tree.calls) == 1
    assert "--install-cross" not in agent_tree.calls[0]
    assert fx.embeds_test_signing_key(staged)


def test_test_hooks_build_is_reused_off_ci(agent_tree, monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    agent_tree.built.write_bytes(b"\x7fELF earlier test build " + _test_key_body())
    fx.stage_remote_agent_binary()
    assert agent_tree.calls == []


def test_ci_builds_once_per_run_and_may_install_cross(agent_tree, monkeypatch):
    monkeypatch.setenv("CI", "true")
    agent_tree.built.write_bytes(b"\x7fELF cached " + _test_key_body())
    fx.stage_remote_agent_binary()
    fx.stage_remote_agent_binary()
    assert len(agent_tree.calls) == 1, "cargo decides freshness once; later calls reuse"
    assert "--install-cross" in agent_tree.calls[0]


def test_build_failure_on_ci_errors_instead_of_skipping(agent_tree, monkeypatch):
    """Before #4092 a missing `cross` skipped every deployed-agent suite on the
    integration lane without turning anything red."""
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(
        subprocess, "run", _failing_run("ERROR: cross-rs not found.\n", returncode=1)
    )
    with pytest.raises(fx.ComposeFixtureFailed, match="cross-rs not found"):
        fx.stage_remote_agent_binary()


def test_build_failure_off_ci_still_skips(agent_tree, monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setattr(
        subprocess, "run", _failing_run("ERROR: cross-rs not found.\n", returncode=1)
    )
    with pytest.raises(ContainerRuntimeUnavailable, match="cross-rs not found"):
        fx.stage_remote_agent_binary()


@pytest.mark.parametrize(
    ("runtime", "os_type", "reason"),
    [(None, None, "no container runtime"), ("docker", "windows", "windows containers")],
    ids=["no-runtime-macos-runner", "windows-daemon"],
)
def test_no_linux_runtime_skips_before_building_even_on_ci(
    agent_tree, monkeypatch, runtime, os_type, reason
):
    """The macOS/Windows CI legs cannot host the Linux containers: skip with that
    reason up front rather than attempting (and blaming) the cross-build."""
    monkeypatch.setenv("CI", "true")
    monkeypatch.setattr(fx, "container_runtime", lambda: runtime)
    monkeypatch.setattr(fx, "_docker_os_type", lambda _runtime: os_type)
    with pytest.raises(ContainerRuntimeUnavailable, match=reason):
        fx.stage_remote_agent_binary()
    assert agent_tree.calls == []


def test_real_swap_container_is_recreated_per_test_attempt(request):
    """#4092: the real-swap test mutates its container (the installed agent is
    swapped), and the integration lane re-runs a failed test. A session-scoped
    fixture handed every rerun the already-swapped container, so the reruns
    failed up front on "the staged update must differ from the installed agent"
    and masked the first attempt's real failure. Function scope re-runs the
    force-recreating bring-up for each attempt."""
    defs = request._fixturemanager.getfixturedefs(
        "remote_agent_update_swap_fixtures", request.node
    )
    assert defs, "conftest must define remote_agent_update_swap_fixtures"
    assert defs[-1].scope == "function"
