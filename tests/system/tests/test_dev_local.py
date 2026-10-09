"""Unit tests for the per-checkout dev.local.json resolver (parallel isolation).

Machinery group (no app): writes a temp dev.local.json and asserts the resolved
project / offset / ports, including env-var precedence. Runs anywhere.
"""

import json
import re

import pytest

from termihub_harness import dev_local


#: A host port the fixture compose file publishes: a single ``*_PORT`` or either
#: end of a port range (``*_PASV_MIN`` / ``*_PASV_MAX``, #4094).
_COMPOSE_PORT_RE = r"\$\{(TERMIHUB_TEST_\w+(?:_PORT|_PASV_MIN|_PASV_MAX)):-(\d+)\}"

#: Slots the coordinator runs side by side (``dev0`` … ``dev9``).
_SLOTS = range(10)


def _write(tmp_path, data):
    (tmp_path / "dev.local.json").write_text(json.dumps(data), encoding="utf-8")
    return tmp_path


def _slot(base, name):
    """Create ``<base>/<name>/termiHub`` (a parallel-checkout layout) and return it."""
    checkout = base / name / "termiHub"
    checkout.mkdir(parents=True)
    return checkout


def _committed_dev_agent_port() -> int:
    """`dev_agent_port` from the committed template (`default.dev.local.json`)."""
    text = (dev_local.REPO_ROOT / "default.dev.local.json").read_text(encoding="utf-8")
    return int(json.loads(text)["dev_agent_port"])


def _committed_e2e_ssh_base() -> int:
    """`TERMIHUB_TEST_E2E_SSH_PORT` base from the shell resolver."""
    text = (
        dev_local.REPO_ROOT / "scripts" / "internal" / "dev-local-env.sh"
    ).read_text(encoding="utf-8")
    match = re.search(r"TERMIHUB_TEST_E2E_SSH_PORT\s+(\d+)", text)
    assert match, "TERMIHUB_TEST_E2E_SSH_PORT not found in dev-local-env.sh"
    return int(match.group(1))


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    # The resolver lets env vars override the file; clear them so each test starts
    # from a known state and only sets what it asserts on.
    for var in (
        "COMPOSE_PROJECT_NAME",
        "TERMIHUB_TEST_PORT_OFFSET",
        "TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL",
        *dev_local.BASE_PORTS,
    ):
        monkeypatch.delenv(var, raising=False)


def test_defaults_when_no_file(tmp_path):
    assert dev_local.compose_project(tmp_path) == "termihub"
    assert dev_local.port_offset(tmp_path) == 0
    assert dev_local.service_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201, tmp_path) == 2201


def test_defaults_when_file_malformed(tmp_path):
    (tmp_path / "dev.local.json").write_text("{not json", encoding="utf-8")
    assert dev_local.compose_project(tmp_path) == "termihub"
    assert dev_local.port_offset(tmp_path) == 0


def test_reads_project_and_offset_from_file(tmp_path):
    _write(tmp_path, {"compose_project": "termihub-test-1", "test_port_offset": 1000})
    assert dev_local.compose_project(tmp_path) == "termihub-test-1"
    assert dev_local.port_offset(tmp_path) == 1000
    # Offset applies to every base port.
    assert dev_local.service_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201, tmp_path) == 3201
    assert dev_local.service_port("TERMIHUB_TEST_TELNET_PORT", 2301, tmp_path) == 3301


def test_env_var_overrides_file(tmp_path, monkeypatch):
    _write(tmp_path, {"compose_project": "from-file", "test_port_offset": 1000})
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "from-env")
    monkeypatch.setenv("TERMIHUB_TEST_PORT_OFFSET", "2000")
    monkeypatch.setenv("TERMIHUB_TEST_SSH_PASSWORD_PORT", "9999")
    assert dev_local.compose_project(tmp_path) == "from-env"
    assert dev_local.port_offset(tmp_path) == 2000
    # An explicit per-service env var wins over the computed base + offset.
    assert dev_local.service_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201, tmp_path) == 9999
    # A service without an explicit override still uses base + offset.
    assert dev_local.service_port("TERMIHUB_TEST_TELNET_PORT", 2301, tmp_path) == 4301


def test_compose_env_covers_project_and_every_service(tmp_path):
    _write(tmp_path, {"compose_project": "termihub-test-2", "test_port_offset": 2000})
    env = dev_local.compose_env(tmp_path)
    assert env["COMPOSE_PROJECT_NAME"] == "termihub-test-2"
    # The compose file interpolates TERMIHUB_TEST_PROJECT (not COMPOSE_PROJECT_NAME,
    # which compose auto-sets) into container/network names.
    assert env["TERMIHUB_TEST_PROJECT"] == "termihub-test-2"
    assert env["TERMIHUB_TEST_PORT_OFFSET"] == "2000"
    # Every base-port var is present and offset; values are strings (subprocess env).
    assert env["TERMIHUB_TEST_SSH_PASSWORD_PORT"] == "4201"
    assert env["TERMIHUB_TEST_NETWORK_TARGET_PORT"] == "10080"
    assert set(dev_local.BASE_PORTS).issubset(env)
    assert all(isinstance(v, str) for v in env.values())


def test_base_ports_cover_every_compose_published_port():
    """Every ``${TERMIHUB_TEST_*_PORT:-<base>}`` (and every port-range end,
    ``*_PASV_MIN`` / ``*_PASV_MAX``) the compose file publishes is in
    :data:`BASE_PORTS` with the same base (#4004, #4094).

    A var missing here is never put in :func:`compose_env`, so ``compose up``
    publishes the service on its *base* port while the harness probes the
    *offset* one — the RDP fixture came up on 2601 and the suite waited on 5601.
    """
    compose = (dev_local.REPO_ROOT / "tests" / "docker" / "docker-compose.yml").read_text(
        encoding="utf-8"
    )
    published = {
        var: int(base)
        for var, base in re.findall(_COMPOSE_PORT_RE, compose)
    }
    assert published, "no published test ports found in docker-compose.yml"
    missing = {var: base for var, base in published.items() if var not in dev_local.BASE_PORTS}
    assert not missing, f"add these to dev_local.BASE_PORTS: {missing}"
    mismatched = {
        var: (base, dev_local.BASE_PORTS[var])
        for var, base in published.items()
        if dev_local.BASE_PORTS[var] != base
    }
    assert not mismatched, f"compose base vs BASE_PORTS: {mismatched}"


def test_dev_agent_port_does_not_collide_with_e2e_ssh_port():
    """Regression for #1536.

    At ``test_port_offset`` 0 a fresh checkout starts both the dev agent's local
    ``sshd`` (``dev_agent_port``) and the quick-start E2E SSH container
    (``TERMIHUB_TEST_E2E_SSH_PORT``). Both bind a host port, so their committed
    defaults must differ — otherwise the second to start fails with "address
    already in use". Historically both defaulted to 2222; the E2E port now sits
    at 2230, clear of the SSH fixture cluster (2201-2218, #4339).
    """
    assert _committed_dev_agent_port() != _committed_e2e_ssh_base()


#: ``dev_agent_port`` of slot N in the documented per-checkout scheme
#: (docs/testing.md "Parallel test isolation": 2222, step 10). It is NOT offset
#: by ``test_port_offset``, so it must avoid every slot's fixture ports.
def _dev_agent_port(slot: int) -> int:
    return _committed_dev_agent_port() + 10 * slot


def _compose_port_defaults() -> dict[str, int]:
    """Every ``${VAR:-default}`` host port published by the fixture compose file."""
    text = (dev_local.REPO_ROOT / "tests" / "docker" / "docker-compose.yml").read_text(
        encoding="utf-8"
    )
    return {
        var: int(default)
        for var, default in re.findall(_COMPOSE_PORT_RE, text)
    }


def _shell_port_bases() -> dict[str, int]:
    """Every ``_thdl_port VAR base`` line of the shell resolver."""
    text = (
        dev_local.REPO_ROOT / "scripts" / "internal" / "dev-local-env.sh"
    ).read_text(encoding="utf-8")
    return {
        var: int(base) for var, base in re.findall(r"^_thdl_port (\w+)\s+(\d+)", text, re.M)
    }


def test_every_compose_fixture_port_is_offset_per_checkout():
    """Regression for #4007: ``ssh-sftp-only`` was published on a fixed host port.

    A compose port the resolvers do not offset is bound at the same host port by
    every checkout, so the second checkout to start it fails or, worse, its
    tests talk to another checkout's container.
    """
    compose = _compose_port_defaults()
    shell = _shell_port_bases()
    missing = sorted(var for var in compose if var not in shell)
    assert not missing, f"compose ports not offset by dev-local-env.sh: {missing}"
    for var, base in compose.items():
        assert shell[var] == base, f"{var}: compose default {base} != shell base {shell[var]}"
        if var in dev_local.BASE_PORTS:
            assert dev_local.BASE_PORTS[var] == base, f"{var}: dev_local.py base differs"


def _host_ports(bases: dict[str, int], offset: int) -> dict[int, str]:
    """Expand ``bases`` at ``offset`` into ``{host_port: owner}``, ranges included.

    A ``*_PASV_MIN`` / ``*_PASV_MAX`` pair publishes every port in between, so the
    whole range is claimed. Raises on a port claimed twice.
    """
    claimed: dict[int, str] = {}

    def claim(port: int, owner: str) -> None:
        assert port not in claimed, f"{owner} and {claimed[port]} both use host port {port}"
        claimed[port] = owner

    for var, base in bases.items():
        if var.endswith("_PASV_MAX"):
            continue
        if var.endswith("_PASV_MIN"):
            top = bases[var[: -len("_MIN")] + "_MAX"]
            assert top >= base, f"{var} range is empty: {base}-{top}"
            for port in range(base, top + 1):
                claim(port + offset, var[: -len("_MIN")])
        else:
            claim(base + offset, var)
    return claimed


def test_compose_fixture_ports_do_not_share_a_host_port():
    """Two fixtures with the same default host port cannot run side by side
    (``ssh-sftp-only`` and ``remote-agent`` both used 2211 until #4007). Passive
    port ranges count as every port they span (#4094)."""
    _host_ports(_compose_port_defaults(), 0)


def test_shell_resolver_ports_do_not_share_a_host_port():
    """Every ``_thdl_port`` base of ``dev-local-env.sh``, including the shell-only
    examples/ quick-start ports, claims its own host port.

    Regression for #4339: the quick-start SSH target and the
    ``remote-agent-pending-update`` fixture both used 2214. Both get the same
    per-slot offset, so they collided in every checkout, and the compose-only
    check above could not see it.
    """
    _host_ports(_shell_port_bases(), 0)


def test_shell_resolver_slots_never_share_a_host_port():
    """Every shell-resolved port of every slot, plus every slot's dev agent port,
    is unique across ``dev0`` … ``dev9`` (#4339)."""
    owners: dict[int, str] = {}
    for slot in _SLOTS:
        ports = _host_ports(_shell_port_bases(), slot * dev_local.OFFSET_PER_SLOT)
        ports[_dev_agent_port(slot)] = "dev_agent_port"
        for port, owner in ports.items():
            assert port not in owners, f"dev{slot} {owner} reuses {owners[port]}'s port {port}"
            owners[port] = f"dev{slot} {owner}"


def test_compose_env_offsets_ftp_passive_ranges(tmp_path):
    """Regression for #4094: ``compose_env`` must offset the ftp-server passive
    ranges, or every checkout publishes 30000-30019 and the second ``compose up``
    fails to bind."""
    _write(tmp_path, {"compose_project": "termihub-test-7", "test_port_offset": 7000})
    env = dev_local.compose_env(tmp_path)
    assert env["TERMIHUB_TEST_FTP_PASV_MIN"] == "37000"
    assert env["TERMIHUB_TEST_FTP_PASV_MAX"] == "37009"
    assert env["TERMIHUB_TEST_FTPS_IMPLICIT_PASV_MIN"] == "37010"
    assert env["TERMIHUB_TEST_FTPS_IMPLICIT_PASV_MAX"] == "37019"


def test_python_and_shell_resolvers_agree_on_every_base():
    """``dev_local.BASE_PORTS`` and ``dev-local-env.sh`` offset the same vars from
    the same bases (the shell side additionally owns the examples/ E2E ports)."""
    shell = _shell_port_bases()
    missing = sorted(var for var in dev_local.BASE_PORTS if var not in shell)
    assert not missing, f"BASE_PORTS vars not offset by dev-local-env.sh: {missing}"
    differ = {
        var: (base, shell[var]) for var, base in dev_local.BASE_PORTS.items() if shell[var] != base
    }
    assert not differ, f"dev_local.py vs dev-local-env.sh base: {differ}"


def test_slots_never_share_a_host_port():
    """Every fixture host port of every slot — passive ranges expanded — is unique
    across ``dev0`` … ``dev9`` at the documented 1000-per-slot offset (#4094)."""
    owners: dict[int, str] = {}
    for slot in _SLOTS:
        for port, owner in _host_ports(
            dev_local.BASE_PORTS, slot * dev_local.OFFSET_PER_SLOT
        ).items():
            assert port not in owners, f"dev{slot} {owner} reuses {owners[port]}'s port {port}"
            owners[port] = f"dev{slot} {owner}"
    assert max(owners) <= 65535, f"highest slot port {max(owners)} is not a valid port"


# --- TIN-016: fail fast on a silently-colliding dev.local.json -----------------


def test_missing_file_in_parallel_checkout_raises(tmp_path):
    """A missing config next to sibling ``dev*/termiHub`` checkouts must fail loud.

    Defaulting to offset 0 there silently steals checkout 0's ports/containers,
    which surfaces as flaky cross-checkout failures rather than a config error.
    """
    me = _slot(tmp_path, "dev1")
    _slot(tmp_path, "dev0")  # a sibling parallel checkout
    with pytest.raises(RuntimeError, match="collide"):
        dev_local.port_offset(me)
    with pytest.raises(RuntimeError, match="collide"):
        dev_local.compose_project(me)


def test_missing_file_solo_checkout_still_defaults(tmp_path):
    """A lone checkout (no sibling ``dev*/termiHub``) keeps the historical default."""
    me = _slot(tmp_path, "dev1")  # no siblings created
    assert dev_local.port_offset(me) == 0
    assert dev_local.compose_project(me) == "termihub"


def test_missing_file_non_slot_layout_defaults(tmp_path):
    """A checkout not under a ``dev<N>`` slot dir (CI/dev machine) defaults quietly."""
    assert dev_local.port_offset(tmp_path) == 0
    assert dev_local.compose_project(tmp_path) == "termihub"


def test_missing_file_parallel_but_env_offset_isolated_defaults(tmp_path, monkeypatch):
    """An explicit ``TERMIHUB_TEST_PORT_OFFSET`` already isolates ports — do not raise."""
    me = _slot(tmp_path, "dev1")
    _slot(tmp_path, "dev0")
    monkeypatch.setenv("TERMIHUB_TEST_PORT_OFFSET", "1000")
    assert dev_local.port_offset(me) == 1000
    # compose_project still reaches the loader; the offset env proves isolation.
    assert dev_local.compose_project(me) == "termihub"


def test_missing_file_parallel_allow_flag_defaults(tmp_path, monkeypatch):
    """The ``TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL`` escape hatch suppresses the guard."""
    me = _slot(tmp_path, "dev1")
    _slot(tmp_path, "dev0")
    monkeypatch.setenv("TERMIHUB_ALLOW_DEFAULT_DEV_LOCAL", "1")
    assert dev_local.port_offset(me) == 0


def test_malformed_file_in_parallel_checkout_raises(tmp_path):
    me = _slot(tmp_path, "dev1")
    _slot(tmp_path, "dev0")
    (me / "dev.local.json").write_text("{not json", encoding="utf-8")
    with pytest.raises(RuntimeError, match="collide"):
        dev_local.port_offset(me)


def test_dev_name_offset_mismatch_raises(tmp_path):
    """``dev_name`` dev3 with the wrong offset would use another slot's ports."""
    _write(tmp_path, {"dev_name": "dev3", "test_port_offset": 1000})
    with pytest.raises(RuntimeError, match="test_port_offset"):
        dev_local.port_offset(tmp_path)


def test_dev_name_without_offset_raises(tmp_path):
    """``dev_name`` dev2 but no offset resolves to 0 — a silent collision with dev0."""
    _write(tmp_path, {"dev_name": "dev2"})
    with pytest.raises(RuntimeError, match="test_port_offset"):
        dev_local.port_offset(tmp_path)


def test_compose_project_slot_mismatch_raises(tmp_path):
    _write(
        tmp_path,
        {
            "dev_name": "dev1",
            "test_port_offset": 1000,
            "compose_project": "termihub-test-3",
        },
    )
    with pytest.raises(RuntimeError, match="compose_project"):
        dev_local.compose_project(tmp_path)


def test_custom_compose_project_name_is_allowed(tmp_path):
    """A non ``termihub-test-<N>`` project name is a valid custom setup, not a clash."""
    _write(
        tmp_path,
        {"dev_name": "dev1", "test_port_offset": 1000, "compose_project": "my-custom"},
    )
    assert dev_local.compose_project(tmp_path) == "my-custom"
    assert dev_local.port_offset(tmp_path) == 1000


def test_consistent_named_config_resolves(tmp_path):
    _write(
        tmp_path,
        {
            "dev_name": "dev2",
            "test_port_offset": 2000,
            "compose_project": "termihub-test-2",
        },
    )
    assert dev_local.port_offset(tmp_path) == 2000
    assert dev_local.compose_project(tmp_path) == "termihub-test-2"
    assert dev_local.service_port("TERMIHUB_TEST_SSH_PASSWORD_PORT", 2201, tmp_path) == 4201


def test_dev0_named_config_offset_zero_is_consistent(tmp_path):
    _write(
        tmp_path,
        {
            "dev_name": "dev0",
            "test_port_offset": 0,
            "compose_project": "termihub-test-0",
        },
    )
    assert dev_local.port_offset(tmp_path) == 0
    assert dev_local.compose_project(tmp_path) == "termihub-test-0"


@pytest.mark.parametrize(
    "committed",
    [
        "default.dev.local.json",
        "examples/dev0.dev.local.json",
        "examples/dev1.dev.local.json",
        "examples/dev2.dev.local.json",
        "examples/dev3.dev.local.json",
    ],
)
def test_committed_configs_are_self_consistent(tmp_path, committed):
    """Every shipped config must pass the self-check (guards against over-strictness)."""
    raw = json.loads((dev_local.REPO_ROOT / committed).read_text(encoding="utf-8"))
    _write(tmp_path, {k: v for k, v in raw.items() if not k.startswith("_")})
    # Must not raise.
    dev_local.port_offset(tmp_path)
    dev_local.compose_project(tmp_path)
