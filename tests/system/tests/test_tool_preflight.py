"""Machinery tests for the session-start runner-tool preflight (#5340, TST-010).

The decision logic runs against fake items here; end-to-end checks run a
throwaway pytest session in a subprocess (as ``test_skip_guard.py`` does) to
prove the conftest wiring stops a lane once, before any test, on a missing tool
(also under xdist), and that only the selected tests count.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from termihub_harness import tool_preflight as tp

_WORKFLOW = Path(tp.__file__).resolve().parents[3] / tp.WORKFLOW


def _mark(*args, **kwargs):
    return SimpleNamespace(args=args, kwargs=kwargs)


class _Item:
    def __init__(self, nodeid, marks=(), fixturenames=(), cls=None):
        self.nodeid = nodeid
        self._marks = list(marks)
        self.fixturenames = list(fixturenames)
        self.cls = cls

    def iter_markers(self, name):
        return iter(self._marks) if name == tp.MARKER else iter(())


def _never_skipped(_item):
    return False


def _requirements(items, platform="linux"):
    return tp.requirements(items, platform, skipped=_never_skipped)


# ── Who needs what ───────────────────────────────────────────────────────────
def test_marker_declares_tools_for_its_platform_only():
    item = _Item("t::x11", [_mark("xdotool", platforms=("linux",))])
    assert _requirements([item], "linux") == {"xdotool": ["t::x11"]}
    assert _requirements([item], "darwin") == {}


def test_a_tool_counts_only_on_platforms_where_it_is_mandatory():
    item = _Item("t::serial", [_mark("socat")])
    assert _requirements([item], "linux") == {"socat": ["t::serial"]}
    assert _requirements([item], "darwin") == {"socat": ["t::serial"]}
    # Windows has no socat: its serial suites are allowlisted skips, not a
    # provisioning error.
    assert _requirements([item], "win32") == {}


def test_fixture_declarations_cover_every_test_that_pulls_the_fixture_in(monkeypatch):
    monkeypatch.setattr(tp, "FIXTURE_TOOLS", {})

    @tp.fixture_needs("docker")
    def ssh_fixtures():  # pragma: no cover - only its name matters
        pass

    items = [
        _Item("t::a", fixturenames=["request", "ssh_fixtures"]),
        _Item("t::b", fixturenames=["request"]),
    ]
    assert _requirements(items) == {"docker": ["t::a"]}
    assert _requirements(items, "darwin") == {}  # no Docker on the macOS runner


def test_unknown_tool_names_are_rejected():
    with pytest.raises(ValueError, match="unknown runner tool"):
        tp.fixture_needs("openboxx")
    with pytest.raises(ValueError, match="unknown runner tool"):
        _requirements([_Item("t::typo", [_mark("xdotol")])])


def test_external_app_shims_with_code_need_the_code_shim():
    class Suite:
        external_app_shims = ("code", "xdg-open")

    class Other:
        external_app_shims = ("xdg-open",)

    items = [_Item("t::code", cls=Suite), _Item("t::fm", cls=Other)]
    assert _requirements(items, "win32") == {"code-shim": ["t::code"]}


def test_statically_skipped_items_do_not_count():
    items = [_Item("t::skipped", [_mark("socat")]), _Item("t::runs", [_mark("socat")])]
    needed = tp.requirements(items, "linux", skipped=lambda item: item.nodeid == "t::skipped")
    assert needed == {"socat": ["t::runs"]}


def test_every_declared_tool_has_an_install_step_on_each_mandatory_platform():
    for tool in tp.TOOLS.values():
        for platform in tool.platforms:
            assert (tool.name, platform) in tp.INSTALL_STEPS, (tool.name, platform)


def test_the_cited_workflow_steps_exist():
    text = _WORKFLOW.read_text(encoding="utf-8")
    for step in set(tp.INSTALL_STEPS.values()):
        if step.startswith("none:"):
            continue
        assert f"- name: {step}\n" in text, step


def test_every_lane_maps_to_a_job():
    lanes = set(re.findall(r"'([a-z0-9-]+-(?:linux|macos|windows)(?:-arm64)?)'", _WORKFLOW.read_text()))
    assert lanes, "no lanes parsed from the workflow"
    for lane in lanes:
        assert tp._job_for(lane), lane


# ── Probing and the message ──────────────────────────────────────────────────
def test_each_needed_tool_is_probed_once():
    calls = []

    def probe(name, result):
        def run():
            calls.append(name)
            return result

        return run

    needed = {"openbox": ["a", "b", "c"], "xprop": ["a"]}
    missing = tp.missing_tools(
        needed, {"openbox": probe("openbox", "not on PATH"), "xprop": probe("xprop", None)}
    )
    assert missing == {"openbox": "not on PATH"}
    assert sorted(calls) == ["openbox", "xprop"]


def test_a_crashing_probe_reads_as_missing():
    def boom():
        raise OSError("nope")

    assert tp.missing_tools({"docker": ["t"]}, {"docker": boom}) == {"docker": "probe failed: nope"}


def test_message_names_tools_lane_job_and_step():
    message = tp.format_message(
        {"openbox": "not on PATH", "xprop": "not on PATH"},
        {"openbox": ["t::a", "t::b"], "xprop": ["t::a"]},
        lane="bulk-linux",
        platform="linux",
    )
    first = message.splitlines()[0]
    assert "2 runner tool(s) missing" in first and "openbox, xprop" in first
    assert "lane bulk-linux" in first
    assert "job 'system-integration'" in message
    assert "Install system dependencies (Tauri + headless display)" in message
    assert tp.WORKFLOW in message
    assert "needed by 2 selected test(s), e.g. t::a" in message
    assert "nothing was skipped or retried" in message


def test_local_message_names_the_marker_expression():
    message = tp.format_message(
        {"socat": "not on PATH"}, {"socat": ["t"]}, lane=None, markexpr="integration",
        platform="darwin", strict=False,
    )
    assert "local run (-m 'integration')" in message
    assert "Install serial fixture dependency (socat)" in message
    assert "warn mode" in message


@pytest.mark.parametrize(
    "env, mode",
    [
        ({}, "warn"),
        ({"TERMIHUB_SKIP_GUARD_LANE": "bulk-linux"}, "strict"),
        ({"GITHUB_ACTIONS": "true"}, "strict"),
        ({"GITHUB_ACTIONS": "true", tp.MODE_ENV: "warn"}, "warn"),
        ({tp.MODE_ENV: "OFF"}, "off"),
        ({tp.MODE_ENV: "strict"}, "strict"),
    ],
)
def test_mode_from_env(env, mode):
    assert tp.mode_from_env(env) == mode


def test_check_session_present_and_missing():
    items = [_Item("t::x", [_mark("socat")])]
    env = {tp.MODE_ENV: "strict"}
    ok = tp.check_session(items, env=env, platform="linux", probes={"socat": lambda: None})
    assert ok is not None and not ok.stops_session and ok.message is None
    assert "socat (1)" in ok.summary_lines()[0]
    bad = tp.check_session(items, env=env, platform="linux", probes={"socat": lambda: "gone"})
    assert bad is not None and bad.stops_session and "socat" in bad.message
    assert tp.check_session(items, env={tp.MODE_ENV: "off"}, platform="linux") is None


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shim path")
def test_the_real_code_shim_probe_passes():
    assert tp.TOOLS["code-shim"].probe() is None


# ── End to end through conftest ──────────────────────────────────────────────
_SUITE = """
import pytest

@pytest.mark.requires_tools("socat")
def test_needs_socat():
    pass

def test_plain():
    pass
"""


def _run_session(tmp_path, *extra, path_dirs=()):
    harness_root = Path(tp.__file__).resolve().parents[1]
    test_file = tmp_path / "test_preflighted.py"
    test_file.write_text(textwrap.dedent(_SUITE), encoding="utf-8")
    env = {**os.environ, tp.MODE_ENV: "strict", "TERMIHUB_SKIP_GUARD_LANE": ""}
    env["PATH"] = os.pathsep.join(str(d) for d in path_dirs) or str(tmp_path / "empty")
    for name in ("GITHUB_STEP_SUMMARY", "PYTEST_XDIST_WORKER", "PYTEST_ADDOPTS"):
        env.pop(name, None)
    return subprocess.run(
        [
            sys.executable, "-m", "pytest", "-p", "no:cacheprovider", "-p", "conftest",
            "--rootdir", str(harness_root), "-c", str(harness_root / "pyproject.toml"),
            str(test_file), *extra,
        ],
        cwd=harness_root, env=env, capture_output=True, text=True, timeout=120,
    )


posix_only = pytest.mark.skipif(sys.platform == "win32", reason="socat is not mandatory on Windows")


@posix_only
@pytest.mark.parametrize("xdist", [(), ("-n", "1")], ids=["serial", "xdist"])
def test_a_missing_tool_stops_the_session_once_before_any_test(tmp_path, xdist):
    result = _run_session(tmp_path, *xdist)
    out = result.stdout + result.stderr
    assert result.returncode == tp.EXIT_CODE, out
    assert out.count("runner tool(s) missing") == 1, out
    assert "socat" in out and "passed" not in out


@posix_only
def test_a_present_tool_lets_the_session_run(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "socat"
    fake.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    fake.chmod(0o755)
    result = _run_session(tmp_path, path_dirs=[bin_dir])
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    assert "2 passed" in out and "socat (1)" in out


@posix_only
def test_only_selected_tests_count(tmp_path):
    result = _run_session(tmp_path, "-k", "test_plain")
    out = result.stdout + result.stderr
    assert result.returncode == 0, out
    assert "1 passed" in out and "termihub tool preflight" not in out
