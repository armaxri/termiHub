"""Unit tests for the per-checkout dev.local.json resolver (parallel isolation).

Machinery group (no app): writes a temp dev.local.json and asserts the resolved
project / offset / ports, including env-var precedence. Runs anywhere.
"""

import json
import re

import pytest

from termihub_harness import dev_local


def _write(tmp_path, data):
    (tmp_path / "dev.local.json").write_text(json.dumps(data), encoding="utf-8")
    return tmp_path


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


def test_dev_agent_port_does_not_collide_with_e2e_ssh_port():
    """Regression for #1536.

    At ``test_port_offset`` 0 a fresh checkout starts both the dev agent's local
    ``sshd`` (``dev_agent_port``) and the quick-start E2E SSH container
    (``TERMIHUB_TEST_E2E_SSH_PORT``). Both bind a host port, so their committed
    defaults must differ — otherwise the second to start fails with "address
    already in use". Historically both defaulted to 2222; the E2E port now sits
    at 2214, just past the SSH cluster (2201-2213).
    """
    assert _committed_dev_agent_port() != _committed_e2e_ssh_base()
