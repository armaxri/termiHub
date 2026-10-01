"""Unit tests for the crash-report seeding helpers (#4009). No app, no container."""

from __future__ import annotations

import subprocess
from datetime import datetime, timezone
from types import SimpleNamespace

from termihub_harness import fixtures
from termihub_harness.ui.diagnostics import (
    agent_crash_notice_testid,
    crash_report_name,
    crash_report_names,
    crash_report_text,
)


def test_report_name_matches_the_apps_format():
    when = datetime(2026, 10, 1, 12, 3, 4, tzinfo=timezone.utc)
    assert crash_report_name(when, pid=42) == "crash-20261001T120304Z-42.txt"


def test_report_names_are_distinct_and_ascending():
    names = crash_report_names(3)
    assert len(set(names)) == 3
    assert names == sorted(names)
    assert all(n.startswith("crash-") and n.endswith(".txt") for n in names)


def test_report_text_carries_the_marker_and_secrets():
    text = crash_report_text("m-1", secrets="password=x")
    assert "seeded crash m-1 password=x" in text
    assert text.startswith("termiHub crash report\n")


def test_agent_notice_testids_match_the_component():
    assert agent_crash_notice_testid("a1") == "agent-crash-notice-a1"
    assert agent_crash_notice_testid("a1", "view") == "agent-crash-notice-view-a1"


def test_write_file_runs_as_the_user_and_feeds_stdin(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return SimpleNamespace(stdout="")

    monkeypatch.setattr(fixtures, "container_runtime", lambda: "docker")
    monkeypatch.setattr(subprocess, "run", fake_run)
    control = fixtures.SshServerControl("remote-agent")
    control.write_file("/home/u/x/crash-1.txt", "body", user="testuser")

    cmd, kwargs = calls[0]
    assert cmd[:5] == ["docker", "exec", "-i", "-u", "testuser"]
    assert cmd[5].endswith("-remote-agent")
    assert cmd[-1] == "/home/u/x/crash-1.txt"
    assert kwargs["input"] == "body"


def test_remove_path_runs_as_root_without_stdin(monkeypatch):
    calls = []
    monkeypatch.setattr(fixtures, "container_runtime", lambda: "docker")
    monkeypatch.setattr(
        subprocess, "run", lambda cmd, **kw: calls.append((cmd, kw)) or SimpleNamespace(stdout="")
    )
    fixtures.SshServerControl("remote-agent").remove_path("/tmp/x")
    cmd, kwargs = calls[0]
    assert cmd[:2] == ["docker", "exec"] and "-u" not in cmd and "-i" not in cmd
    assert cmd[-3:] == ["-rf", "--", "/tmp/x"]
    assert kwargs["input"] is None
