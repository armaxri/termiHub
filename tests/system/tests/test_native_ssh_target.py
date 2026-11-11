"""Unit tests for the native sshd as the system-test SSH target (#5176).

Pins :mod:`termihub_harness.native_ssh` without starting any sshd: the env
contract that selects it, which tests it skips on which platform, the
bastion's gateway count, and the server-control twin's session lookup and
``ssh`` plumbing (#5421).
"""

from __future__ import annotations

import os
import subprocess
import sys

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


def test_a_test_that_also_needs_another_container_keeps_that_reason():
    """VNC over an SSH tunnel: the VNC container, not the SSH side, keeps it
    off, so it is left to that fixture's own skip at setup (#5176)."""
    names = ["ssh_password_fixtures", "vnc_fixtures"]
    containers = {"vnc_fixtures", "ssh_fixtures", "ssh_password_fixtures"}
    assert (
        skip_reason(names, None, target=TARGET, platform="darwin", container_fixtures=containers)
        is None
    )
    assert skip_reason(names, None, target=TARGET, platform="darwin") == NOT_PORTED_REASON


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


# ── NativeSshServerControl (#5421) ────────────────────────────────────────────
#: ``ps -A -o pid=,ppid=,uid=,args=`` around a root ``--password-login`` master
#: (100): a terminal connection (200 -> 201), a helper exec session (300 -> 301,
#: ``notty``), another user's connection, and an unrelated sshd elsewhere.
PS_ROOT_MASTER = """\
  100     1     0 sshd: /usr/sbin/sshd -f /s/sshd_config -E /s/sshd.log [listener]
  200   100     0 sshd-session: termihubssh [priv]
  201   200   601 sshd-session: termihubssh@ttys003
  202   201   601 -zsh
  300   100     0 sshd-session: termihubssh [priv]
  301   300   601 sshd-session: termihubssh@notty
  400   100     0 sshd-session: other [priv]
  401   400   602 sshd-session: other@ttys004
  500     1     0 sshd: /usr/sbin/sshd -D [listener]
  501   500     0 sshd-session: termihubssh [priv]
  502   501   601 sshd-session: termihubssh@ttys005
garbage line
"""

#: The unprivileged fixture: the handler runs as the login user too, and an
#: older OpenSSH titles its processes ``sshd:``.
PS_UNPRIVILEGED = """\
  100     1   501 sshd: /usr/sbin/sshd -f /s/sshd_config [listener] 0 of 200-300 startups
  200   100   501 sshd: arne [priv]
  201   200   501 sshd: arne@pts/0
"""


def test_terminal_sessions_are_the_login_users_tty_connections_to_the_master():
    pids = native_ssh.terminal_session_pids(
        PS_ROOT_MASTER, master_pid="100", username="termihubssh", uid=601
    )
    # Not the root handler (cannot be signalled), not the notty helper exec,
    # not another user, not a connection to a different sshd.
    assert pids == {"201"}


def test_unprivileged_sessions_include_the_handler():
    pids = native_ssh.terminal_session_pids(
        PS_UNPRIVILEGED, master_pid="100", username="arne", uid=501
    )
    assert pids == {"200", "201"}


def test_no_master_children_means_no_sessions():
    assert native_ssh.terminal_session_pids("", master_pid="100", username="u", uid=1) == set()


KEYED = NativeSshTarget(port=22400, username="u", password="p", state_dir="/s", key="/s/client")


def test_server_control_needs_a_key_and_a_posix_host():
    assert native_ssh.NativeSshServerControl(KEYED, platform="darwin").available
    assert not native_ssh.NativeSshServerControl(KEYED, platform="win32").available
    assert not native_ssh.NativeSshServerControl(TARGET, platform="darwin").available


def test_target_reads_the_client_key():
    target = target_from_env({**ENV, "TERMIHUB_NATIVE_SSHD_KEY": "/tmp/state/client_ed25519_key"})
    assert target.key == "/tmp/state/client_ed25519_key"


def test_ssh_argv_runs_sh_with_quoted_args_and_ignores_the_callers_config():
    argv = native_ssh.NativeSshServerControl(KEYED).ssh_argv('cat -- "$1"', "/a b/it's")
    assert argv[:3] == ["ssh", "-F", "/dev/null"]
    assert argv[argv.index("-i") + 1] == "/s/client"
    assert argv[argv.index("-p") + 1] == "22400"
    assert "IdentitiesOnly=yes" in argv and "BatchMode=yes" in argv
    assert argv[-2] == "u@127.0.0.1"
    import shlex

    assert shlex.split(argv[-1]) == ["sh", "-c", 'cat -- "$1"', "sh", "/a b/it's"]


def test_server_control_writes_only_as_the_login_user():
    control = native_ssh.NativeSshServerControl(KEYED)
    with pytest.raises(ValueError, match="only write as its login user"):
        control.write_file("/x", "x", user="testuser")
    with pytest.raises(ValueError, match="only write as its login user"):
        control.write_random_file("/x", 1, user="testuser")


def test_server_control_runs_over_ssh_and_reports_failures(monkeypatch):
    control = native_ssh.NativeSshServerControl(KEYED)
    calls = []

    class _Result:
        def __init__(self, returncode, stdout=b"", stderr=b""):
            self.returncode, self.stdout, self.stderr = returncode, stdout, stderr

    replies = iter([_Result(0, b"/Users/u\n"), _Result(0, b"   4096\n"), _Result(1, b"", b"boom")])

    def fake_run(cmd, **kw):
        calls.append((cmd, kw.get("input")))
        return next(replies)

    monkeypatch.setattr(native_ssh.subprocess, "run", fake_run)
    assert control.home() == "/Users/u"
    assert control.home() == "/Users/u", "cached: one ssh round trip"
    assert control.file_size("/Users/u/f") == 4096
    with pytest.raises(native_ssh.NativeSshExecError, match="boom"):
        control.remove_path("/Users/u/f")
    assert len(calls) == 3


def test_kill_sessions_refuses_non_pids():
    with pytest.raises(ValueError):
        native_ssh.NativeSshServerControl(KEYED).kill_sessions(["123; rm -rf /"])


def test_ssh_server_control_picks_the_native_twin(monkeypatch):
    from termihub_harness import fixtures

    # The Docker control probes `docker info` when built; no runtime is needed here.
    monkeypatch.setattr(fixtures, "container_runtime", lambda: None)
    monkeypatch.setattr(fixtures, "NATIVE_SSH_TARGET", KEYED)
    assert isinstance(fixtures.ssh_server_control(), native_ssh.NativeSshServerControl)
    assert isinstance(
        fixtures.ssh_server_control(fixtures.SSH_KEYS_SERVICE), native_ssh.NativeSshServerControl
    )
    # Where the native target serves no fixture-specific hosts (Windows), the
    # sudo and SFTP-only hosts stay Docker; on macOS they are native (#5423).
    monkeypatch.setattr(native_ssh, "HOST_PLATFORMS", ())
    assert isinstance(fixtures.ssh_server_control("ssh-sudo"), fixtures.SshServerControl)
    monkeypatch.setattr(native_ssh, "HOST_PLATFORMS", (sys.platform,))
    for service in (fixtures.SSH_SUDO_SERVICE, fixtures.SSH_SFTP_ONLY_SERVICE):
        assert isinstance(fixtures.ssh_server_control(service), native_ssh.NativeSshServerControl)
    # The no-sudo host's files are another user's: no control of it is offered.
    assert isinstance(
        fixtures.ssh_server_control(fixtures.SSH_NOSUDO_SERVICE), fixtures.SshServerControl
    )
    monkeypatch.setattr(fixtures, "NATIVE_SSH_TARGET", None)
    control = fixtures.ssh_server_control()
    assert isinstance(control, fixtures.SshServerControl)
    assert control.home() == "/home/testuser"


# ── Deployed agent on the native sshd (#5424) ─────────────────────────────────
def test_agent_suites_are_served_on_macos_only():
    assert native_ssh.serves_agent("darwin")
    assert not native_ssh.serves_agent("win32")
    assert native_ssh.served_fixtures("darwin") >= native_ssh.AGENT_FIXTURES
    assert not native_ssh.served_fixtures("win32") & native_ssh.AGENT_FIXTURES


def test_unmarked_agent_suite_is_not_ported_on_macos_only():
    names = ["remote_agent_fixtures"]
    containers = {"remote_agent_fixtures", "remote_agent_pending_fixtures", "vnc_fixtures"}
    darwin = skip_reason(names, None, target=TARGET, platform="darwin", container_fixtures=containers)
    assert darwin == NOT_PORTED_REASON
    # Windows keeps the container fixture's own skip reason.
    assert (
        skip_reason(names, None, target=TARGET, platform="win32", container_fixtures=containers)
        is None
    )
    marked = skip_reason(
        names, ("darwin",), target=TARGET, platform="darwin", container_fixtures=containers
    )
    assert marked is None


def test_agent_variants_are_served_on_macos_too():
    """#5444: the armed, real-swap and keyboard-interactive agent hosts run as
    variant sshds of the fixture, so unmarked they skip as not ported on macOS;
    a test that also needs another container keeps that container's reason."""
    containers = {"remote_agent_pending_fixtures", "remote_agent_update_swap_fixtures", "vnc_fixtures"}
    for name in ("remote_agent_pending_fixtures", "remote_agent_update_swap_fixtures"):
        assert (
            skip_reason([name], None, target=TARGET, platform="darwin", container_fixtures=containers)
            == NOT_PORTED_REASON
        )
        assert (
            skip_reason([name], ("darwin",), target=TARGET, platform="darwin", container_fixtures=containers)
            is None
        )
        assert (
            skip_reason([name], None, target=TARGET, platform="win32", container_fixtures=containers)
            is None
        )
    both = ["remote_agent_pending_fixtures", "vnc_fixtures"]
    assert (
        skip_reason(both, None, target=TARGET, platform="darwin", container_fixtures=containers)
        is None
    )


class _FakeSsh:
    """Replays ssh results per script substring and records what ran."""

    def __init__(self, replies):
        self.replies = replies
        self.calls = []

    def __call__(self, cmd, **kw):
        import shlex as _shlex

        script = _shlex.split(cmd[-1])[2]
        self.calls.append((script, kw.get("input")))
        for needle, out in self.replies:
            if needle in script:
                value = out(script) if callable(out) else out

                class _R:
                    returncode = 0
                    stdout = value
                    stderr = b""

                return _R()
        raise AssertionError(f"unexpected script {script!r}")


def test_install_agent_streams_and_renames_then_verifies(tmp_path, monkeypatch):
    import hashlib

    binary = tmp_path / "termihub-agent"
    binary.write_bytes(b"AGENT-BINARY")
    digest = hashlib.sha256(b"AGENT-BINARY").hexdigest()
    state = {"installed": False}

    def exists(_):
        return b"yes" if state["installed"] else b"no"

    def install(_):
        state["installed"] = True
        return b""

    fake = _FakeSsh(
        [
            ('"$HOME"', b"/Users/u"),
            ("[ -e", exists),
            ("mv -f", install),
            ("sha256", f"{digest}  -\n".encode()),
        ]
    )
    monkeypatch.setattr(native_ssh.subprocess, "run", fake)
    control = native_ssh.NativeSshServerControl(KEYED)
    assert control.install_agent(binary) == "/Users/u/.local/bin/termihub-agent"
    streamed = [inp for script, inp in fake.calls if "mv -f" in script]
    assert streamed == [b"AGENT-BINARY"]
    # Already installed with the same digest: no second upload.
    fake.calls.clear()
    control.install_agent(binary)
    assert not [s for s, _ in fake.calls if "mv -f" in s]


def test_install_agent_fails_on_a_digest_mismatch(tmp_path, monkeypatch):
    binary = tmp_path / "termihub-agent"
    binary.write_bytes(b"AGENT-BINARY")
    fake = _FakeSsh(
        [('"$HOME"', b"/Users/u"), ("[ -e", b"no"), ("mv -f", b""), ("sha256", b"00 -\n")]
    )
    monkeypatch.setattr(native_ssh.subprocess, "run", fake)
    with pytest.raises(native_ssh.NativeSshExecError, match="expected"):
        native_ssh.NativeSshServerControl(KEYED).install_agent(binary)


def test_agent_service_control_is_native_on_macos(monkeypatch):
    from termihub_harness import fixtures

    monkeypatch.setattr(fixtures, "container_runtime", lambda: None)
    monkeypatch.setattr(fixtures, "NATIVE_SSH_TARGET", KEYED)
    monkeypatch.setattr(native_ssh, "AGENT_PLATFORMS", (sys.platform,))
    assert isinstance(
        fixtures.ssh_server_control(fixtures.REMOTE_AGENT_SERVICE),
        native_ssh.NativeSshServerControl,
    )
    monkeypatch.setattr(native_ssh, "AGENT_PLATFORMS", ())
    control = fixtures.ssh_server_control(fixtures.REMOTE_AGENT_SERVICE)
    assert isinstance(control, fixtures.SshServerControl)
    assert control.agent_crash_dir() == "/home/testuser/.config/termihub-agent/logs/crash-reports"


# ── Agent-host variants (#5444) ───────────────────────────────────────────────
def test_variant_ports_are_fixed_offsets_above_the_main_sshd():
    ports = {name: native_ssh.variant_port(TARGET, name) for name in ("pending", "swap", "kbdint")}
    assert ports == {"pending": 22410, "swap": 22411, "kbdint": 22412}
    assert TARGET.jump_port not in ports.values()


def test_variant_up_passes_its_port_env_and_kbdint(monkeypatch, tmp_path):
    target = NativeSshTarget(port=1000, username="u", password="p", state_dir=str(tmp_path))
    calls = []

    class _Done:
        returncode = 0
        stdout = "log line\n/home/v/pending\n"
        stderr = ""

    def fake_run(cmd, **_kw):
        calls.append(cmd)
        return _Done()

    monkeypatch.setattr(native_ssh.subprocess, "run", fake_run)
    variant = native_ssh.NativeAgentVariant(target, "kbdint")
    assert variant.up({"A": "1", "B": "two"}, kbdint=True) == "/home/v/pending"
    (cmd,) = calls
    assert cmd[2:7] == ["variant-up", "--variant", "kbdint", "--port", "1012"]
    assert cmd[7:11] == ["--setenv", "A=1", "--setenv", "B=two"]
    assert "--kbdint" in cmd and cmd[-2:] == ["--dir", str(tmp_path)]


def test_variant_up_failure_is_an_error_not_a_skip(monkeypatch, tmp_path):
    target = NativeSshTarget(port=1000, username="u", password="p", state_dir=str(tmp_path))

    class _Failed:
        returncode = 1
        stdout = ""
        stderr = "--kbdint needs a --password-login fixture"

    monkeypatch.setattr(native_ssh.subprocess, "run", lambda *_a, **_k: _Failed())
    with pytest.raises(native_ssh.NativeSshExecError, match="password-login"):
        native_ssh.NativeAgentVariant(target, "kbdint").up(kbdint=True)


def test_ed25519_matches_the_rfc8032_vector():
    from termihub_harness import ed25519

    # RFC 8032 section 7.1, TEST 2 (one-byte message 0x72).
    seed = bytes.fromhex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    assert ed25519.public_key(seed).hex() == (
        "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c"
    )
    assert ed25519.sign(seed, b"\x72").hex() == (
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da"
        "085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
    )


def test_ed25519_reads_the_committed_test_only_key():
    from termihub_harness import ed25519
    from termihub_harness.fixtures import TEST_ONLY_UPDATE_KEY

    seed = ed25519.seed_from_pem(TEST_ONLY_UPDATE_KEY.read_text(encoding="utf-8"))
    assert len(seed) == 32
    signature = ed25519.sign_agent_update(b"agent bytes", TEST_ONLY_UPDATE_KEY)
    import base64

    assert len(base64.b64decode(signature)) == 64
    with pytest.raises(ValueError):
        ed25519.seed_from_pem("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n")


# ── Fixture-specific hosts (#5423) ────────────────────────────────────────────
def test_fixture_specific_hosts_are_served_on_macos_only():
    hosts = set(native_ssh.HOST_FIXTURES)
    assert hosts == {"ssh_permission_fixtures", "ssh_banner_fixtures", "ssh_sftp_only_fixtures"}
    assert native_ssh.served_fixtures("darwin") >= hosts
    assert not native_ssh.served_fixtures("win32") & hosts
    containers = hosts | {"vnc_fixtures"}
    for name in hosts:
        # Unmarked: not ported on macOS; marked: runs; Windows keeps the
        # container fixture's own skip reason.
        assert (
            skip_reason([name], None, target=TARGET, platform="darwin", container_fixtures=containers)
            == NOT_PORTED_REASON
        )
        assert (
            skip_reason([name], ("darwin",), target=TARGET, platform="darwin", container_fixtures=containers)
            is None
        )
        assert (
            skip_reason([name], None, target=TARGET, platform="win32", container_fixtures=containers)
            is None
        )


def test_every_host_is_a_variant_with_flags_and_its_own_port():
    names = [name for hosts in native_ssh.HOST_FIXTURES.values() for name in hosts]
    assert sorted(names) == sorted(native_ssh.HOST_VARIANT_FLAGS)
    ports = {name: native_ssh.variant_port(TARGET, name) for name in native_ssh.VARIANT_PORT_OFFSETS}
    assert len(set(ports.values())) == len(ports), "two variants share a port"
    assert TARGET.jump_port not in ports.values()
    assert ports["sudo"] == 22413 and ports["sftponly"] == 22416
    # Only the sudo host gets the sudo rule; the no-sudo host is the second user.
    assert "--sudoer" in native_ssh.HOST_VARIANT_FLAGS["sudo"]
    assert "--sudoer" not in native_ssh.HOST_VARIANT_FLAGS["nosudo"]
    assert "--second-user" in native_ssh.HOST_VARIANT_FLAGS["nosudo"]


def test_variant_up_passes_the_host_flags(monkeypatch, tmp_path):
    target = NativeSshTarget(port=1000, username="u", password="p", state_dir=str(tmp_path))
    calls = []

    class _Done:
        returncode = 0
        stdout = "/home/v/sudo\n"
        stderr = ""

    def fake_run(cmd, **_kw):
        calls.append(cmd)
        return _Done()

    monkeypatch.setattr(native_ssh.subprocess, "run", fake_run)
    variant = native_ssh.NativeAgentVariant(target, "sudo")
    assert variant.ensure(flags=native_ssh.HOST_VARIANT_FLAGS["sudo"]) == "/home/v/sudo"
    (cmd,) = calls
    assert cmd[2:7] == ["variant-up", "--variant", "sudo", "--port", "1013"]
    assert cmd[7:9] == ["--sudoer", "--elevated-target"]


@pytest.fixture
def fixture_state(tmp_path, monkeypatch):
    """A fake fixture state dir (no sshd), and a ``sudo`` shim that records any call.

    The real script runs against it: every refusal below must happen before
    anything privileged, so the shim must never be called.
    """
    if sys.platform == "win32":
        pytest.skip("the fixture script's POSIX path")
    state = tmp_path / "state"
    state.mkdir()
    (state / "sshd_config").write_text("# fake\n", encoding="utf-8")
    (state / "port").write_text("1\n", encoding="utf-8")
    shims = tmp_path / "bin"
    shims.mkdir()
    marker = tmp_path / "sudo-called"
    shim = shims / "sudo"
    shim.write_text(f"#!/bin/sh\necho \"$@\" >> '{marker}'\nexit 1\n", encoding="utf-8")
    shim.chmod(0o755)
    monkeypatch.setenv("PATH", f"{shims}:{os.environ['PATH']}")
    for name in ("CI", "TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER", "GITHUB_ACTIONS"):
        monkeypatch.delenv(name, raising=False)
    return state, marker


def _fixture_sh(*args):
    return subprocess.run(
        ["bash", str(native_ssh._FIXTURE_SH), *args],
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.mark.parametrize("flag", ["--sudoer", "--second-user", "--elevated-target"])
def test_system_changes_refuse_off_ci(fixture_state, flag):
    state, marker = fixture_state
    result = _fixture_sh("variant-up", "--variant", "sudo", "--port", "2", flag, "--dir", str(state))
    assert result.returncode != 0
    assert "runs only on CI" in result.stderr
    assert not marker.exists(), "nothing privileged may run before the guard"
    assert not (state / "variants" / "sudo").exists()


def test_system_changes_need_the_root_fixture_even_when_allowed(fixture_state, monkeypatch):
    state, marker = fixture_state
    monkeypatch.setenv("TERMIHUB_NATIVE_SSHD_ALLOW_SYSTEM_USER", "1")
    result = _fixture_sh("variant-up", "--variant", "sudo", "--port", "2", "--sudoer", "--dir", str(state))
    assert result.returncode != 0
    assert "needs a --password-login fixture" in result.stderr
    assert not marker.exists()


def test_sudoer_and_second_user_exclude_each_other(fixture_state):
    state, marker = fixture_state
    result = _fixture_sh(
        "variant-up", "--variant", "x", "--port", "2", "--sudoer", "--second-user", "--dir", str(state)
    )
    assert result.returncode != 0
    assert "exclude each other" in result.stderr
    assert not marker.exists()


@pytest.mark.parametrize(
    ("state_file", "content", "message"),
    [
        ("sudoers_dropin", "/etc/sudoers", "unexpected sudoers file"),
        ("elevated_target", "/etc/passwd", "unexpected file"),
        ("second_user", "someone", "unexpected user"),
    ],
)
def test_down_removes_only_the_recorded_fixed_paths(fixture_state, state_file, content, message):
    state, marker = fixture_state
    (state / state_file).write_text(content + "\n", encoding="utf-8")
    result = _fixture_sh("down", "--dir", str(state))
    assert result.returncode != 0
    assert message in result.stderr
    assert not marker.exists()


def test_down_without_system_changes_is_idempotent(fixture_state):
    state, marker = fixture_state
    for _ in range(2):
        result = _fixture_sh("down", "--dir", str(state))
        assert result.returncode == 0, result.stderr
    assert not state.exists()
    assert not marker.exists()
