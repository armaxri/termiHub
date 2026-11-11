"""Unit tests for the native sshd as the system-test SSH target (#5176).

Pins :mod:`termihub_harness.native_ssh` without starting any sshd: the env
contract that selects it, which tests it skips on which platform, and the
bastion's gateway count from ``netstat`` output.
"""

from __future__ import annotations

import pytest

from termihub_harness import native_ssh
from termihub_harness.native_ssh import (
    NO_BASTION_REASON,
    NOT_PORTED_REASON,
    NativeBastionControl,
    NativeSshTarget,
    NativeSshTargetError,
    per_connection_children,
    skip_reason,
    target_from_env,
)

ENV = {
    "TERMIHUB_SYSTEM_SSH_TARGET": "native",
    "TERMIHUB_NATIVE_SSHD_PORT": "22400",
    "TERMIHUB_NATIVE_SSHD_USER": "termihubssh",
    "TERMIHUB_NATIVE_SSHD_PASSWORD": "Tnabc123",
    "TERMIHUB_NATIVE_SSHD_DIR": "/tmp/state",
}

TARGET = NativeSshTarget(port=22400, username="u", password="p", state_dir="/s", jump_port=22401)


@pytest.mark.parametrize("value", [None, "", "compose", " Compose "])
def test_compose_or_unset_selects_no_native_target(value):
    env = {} if value is None else {"TERMIHUB_SYSTEM_SSH_TARGET": value}
    assert target_from_env(env) is None


def test_native_reads_the_fixture_exports():
    target = target_from_env({**ENV, "TERMIHUB_NATIVE_SSHD_JUMP_PORT": "22401"})
    assert target == NativeSshTarget(
        port=22400,
        username="termihubssh",
        password="Tnabc123",
        state_dir="/tmp/state",
        jump_port=22401,
    )
    assert target_from_env(ENV).jump_port is None


def test_native_without_a_password_fails_instead_of_skipping():
    env = {k: v for k, v in ENV.items() if k != "TERMIHUB_NATIVE_SSHD_PASSWORD"}
    with pytest.raises(NativeSshTargetError, match="TERMIHUB_NATIVE_SSHD_PASSWORD"):
        target_from_env(env)


def test_unknown_target_value_is_an_error():
    with pytest.raises(NativeSshTargetError, match="expected 'native' or 'compose'"):
        target_from_env({"TERMIHUB_SYSTEM_SSH_TARGET": "docker"})


def test_tests_without_ssh_fixtures_are_untouched():
    assert skip_reason(["app", "bridge"], None, target=TARGET, platform="darwin") is None


def test_unmarked_ssh_suite_is_skipped_as_not_ported():
    assert skip_reason(["ssh_fixtures"], None, target=TARGET, platform="darwin") == NOT_PORTED_REASON


def test_marked_suite_runs_only_on_its_platforms():
    marked = ("darwin",)
    assert skip_reason(["ssh_password_fixtures"], marked, target=TARGET, platform="darwin") is None
    assert (
        skip_reason(["ssh_password_fixtures"], marked, target=TARGET, platform="win32")
        == NOT_PORTED_REASON
    )


def test_jump_host_suite_needs_the_bastion():
    no_jump = NativeSshTarget(port=1, username="u", password="p", state_dir="/s")
    names = ["ssh_bastion_fixtures"]
    assert skip_reason(names, ("darwin",), target=no_jump, platform="darwin") == NO_BASTION_REASON
    assert skip_reason(names, ("darwin",), target=TARGET, platform="darwin") is None


class _Item:
    def __init__(self, fixturenames, marker=None):
        self.fixturenames = fixturenames
        self._marker = marker
        self.added = []

    def get_closest_marker(self, name):
        assert name == native_ssh.MARKER
        return self._marker

    def add_marker(self, marker):
        self.added.append(marker)


def test_apply_markers_skips_only_unported_ssh_tests():
    ported = _Item(["ssh_fixtures"], pytest.mark.native_sshd.mark)
    darwin_only = _Item(["ssh_fixtures"], pytest.mark.native_sshd(platforms=("darwin",)).mark)
    unported = _Item(["ssh_fixtures"])
    other = _Item(["app"])
    native_ssh.apply_markers([ported, darwin_only, unported, other], TARGET, platform="win32")
    assert ported.added == [] and other.added == []
    assert [m.kwargs["reason"] for m in darwin_only.added] == [NOT_PORTED_REASON]
    assert [m.kwargs["reason"] for m in unported.added] == [NOT_PORTED_REASON]


def test_apply_markers_is_a_noop_without_a_native_target():
    unported = _Item(["ssh_fixtures"])
    native_ssh.apply_markers([unported], None, platform="darwin")
    assert unported.added == []


def test_gateway_count_is_the_masters_children():
    assert per_connection_children("") == 0
    assert per_connection_children("3913\n3920\n") == 2


def test_gateway_count_reads_the_bastion_pid(tmp_path, monkeypatch):
    target = NativeSshTarget(port=1, username="u", password="p", state_dir=str(tmp_path), jump_port=2)
    bastion = NativeBastionControl(target)
    assert bastion.gateway_sessions() == 0, "no pid file: the bastion is down"
    (tmp_path / "jump_sshd.pid").write_text("4242\n", encoding="utf-8")
    calls = []

    class _Done:
        stdout = "5001\n"

    def fake_run(cmd, **_kw):
        calls.append(cmd)
        return _Done()

    monkeypatch.setattr(native_ssh.subprocess, "run", fake_run)
    assert bastion.gateway_sessions() == 1
    assert calls == [["pgrep", "-P", "4242"]]


def test_bastion_control_needs_a_jump_port():
    with pytest.raises(NativeSshTargetError):
        NativeBastionControl(NativeSshTarget(port=1, username="u", password="p", state_dir="/s"))
    assert NativeBastionControl(TARGET).port == 22401
