"""Unit tests for the real-host / real-hardware guided helpers (#919).

The guided-manual suites skip without an operator, so these pure helpers are
the part of them that runs on every PR (normal, non-integration lane).
"""

from __future__ import annotations

import pytest

from termihub_harness.guided import (
    REAL_AGENT_HOST_ENV,
    HostSpec,
    host_from_env,
    is_termihub_app_name,
    missing_env_reason,
    other_termihub_pids,
    parse_host_spec,
    running_other_termihub_pids,
)


class TestParseHostSpec:
    def test_user_and_host_default_to_port_22(self):
        assert parse_host_spec("pi@raspberrypi.local") == HostSpec("pi", "raspberrypi.local", 22)

    def test_explicit_port(self):
        assert parse_host_spec("me@winbox:2222") == HostSpec("me", "winbox", 2222)

    def test_bracketed_ipv6_with_port(self):
        spec = parse_host_spec("me@[fe80::1]:22")
        assert spec == HostSpec("me", "fe80::1", 22)
        assert str(spec) == "me@[fe80::1]:22"

    def test_domain_user_is_kept(self):
        assert parse_host_spec("CORP\\alice@rdp.corp").user == "CORP\\alice"

    def test_surrounding_whitespace_is_ignored(self):
        assert parse_host_spec("  me@host:22\n") == HostSpec("me", "host", 22)

    @pytest.mark.parametrize("bad", ["host", "@host", "me@", "me@host:", "me@host:abc", ""])
    def test_malformed_spec_names_the_expected_shape(self, bad):
        with pytest.raises(ValueError, match="user@host"):
            parse_host_spec(bad)

    @pytest.mark.parametrize("port", ["0", "65536"])
    def test_port_out_of_range_is_rejected(self, port):
        with pytest.raises(ValueError, match="1..65535"):
            parse_host_spec(f"me@host:{port}")


class TestHostFromEnv:
    def test_unset_or_blank_is_none(self):
        assert host_from_env(REAL_AGENT_HOST_ENV, environ={}) is None
        assert host_from_env(REAL_AGENT_HOST_ENV, environ={REAL_AGENT_HOST_ENV: "  "}) is None

    def test_set_value_is_parsed(self):
        env = {REAL_AGENT_HOST_ENV: "pi@10.0.0.5:22"}
        assert host_from_env(REAL_AGENT_HOST_ENV, environ=env) == HostSpec("pi", "10.0.0.5")

    def test_skip_reason_names_variable_and_example(self):
        reason = missing_env_reason("X_HOST", "me@h:22", "a real host")
        assert "X_HOST=me@h:22" in reason and "a real host" in reason


class TestOtherTermihubInstances:
    @pytest.mark.parametrize(
        "name", ["termiHub", "termihub", "termiHub.exe", "/Applications/termiHub.app/termiHub"]
    )
    def test_app_names_match(self, name):
        assert is_termihub_app_name(name)

    @pytest.mark.parametrize(
        "name",
        ["termihub-agent", "termihub-agent.exe", "termihub-rdp-sidecar", "zsh", "", "Terminal"],
    )
    def test_helpers_and_other_programs_do_not_match(self, name):
        assert not is_termihub_app_name(name)

    def test_own_instance_is_excluded(self):
        rows = [(10, "termiHub"), (11, "termiHub"), (12, "termihub-agent"), (13, "zsh")]
        assert other_termihub_pids(rows, own_pids=[11]) == [10]

    def test_no_other_instance(self):
        assert other_termihub_pids([(11, "termiHub")], own_pids=[11]) == []

    def test_live_process_table_read_is_safe(self):
        # Reads only; the current interpreter is never a termiHub app.
        import os

        assert os.getpid() not in running_other_termihub_pids([os.getpid()])
