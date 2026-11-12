"""Unit tests for finding test apps left running (#5086).

:mod:`termihub_harness.app_leaks` matches a process only by the owner tag in its
own environment, so these run against fake process entries: a leak is an app
process of this pytest process that no live instance tracks. Machinery tests
(no ``integration`` marker).
"""

from __future__ import annotations

import subprocess
import sys

import psutil

from termihub_harness import app_leaks
from termihub_harness.relaunch import BRIDGE_PORT_ENV

OWNER = "4242"


class _Proc:
    def __init__(self, pid, name, env, *, denied=False):
        self.pid = pid
        self._name = name
        self._env = env
        self._denied = denied

    def name(self):
        return self._name

    def environ(self):
        if self._denied:
            raise psutil.AccessDenied(self.pid)
        return self._env


def _tagged(pid, port=None, name="termihub"):
    env = {app_leaks.OWNER_ENV: OWNER}
    if port is not None:
        env[BRIDGE_PORT_ENV] = str(port)
    return _Proc(pid, name, env)


def _find(procs, *, pids=(), ports=()):
    return [
        p.pid
        for p in app_leaks.find_leaked_apps(
            procs, owner=OWNER, live_pids=set(pids), live_ports={str(p) for p in ports}
        )
    ]


def test_an_untracked_app_of_this_session_is_a_leak():
    assert _find([_tagged(10, 5000)]) == [10]


def test_the_app_name_is_matched_on_every_os():
    procs = [_tagged(1, name="termihub.exe"), _tagged(2, name="termiHub"), _tagged(3)]
    assert _find(procs) == [1, 2, 3]


def test_a_live_instances_app_is_not_a_leak():
    assert _find([_tagged(10, 5000)], pids=[10]) == []


def test_an_unadopted_relaunch_of_a_live_instance_is_not_a_leak():
    # The relaunch has a new PID but inherited its instance's bridge port.
    assert _find([_tagged(11, 5000)], pids=[10], ports=[5000]) == []


def test_a_cli_run_that_fell_through_to_a_full_launch_is_a_leak():
    assert _find([_tagged(12)], ports=[5000]) == [12]


def test_other_owners_and_untagged_apps_are_never_touched():
    procs = [
        _Proc(20, "termihub", {app_leaks.OWNER_ENV: "1"}),  # another worker/checkout
        _Proc(21, "termihub", {}),  # the developer's own termiHub
        _Proc(22, "termihub", {}, denied=True),
    ]
    assert _find(procs) == []


def test_only_the_app_binary_counts_not_its_shells():
    # A shell the app started inherits the tag; it dies with its app's tree.
    procs = [_tagged(30, name="bash"), _tagged(31, name="termihub-agent")]
    assert _find(procs) == []


def test_reap_leaks_is_a_no_op_before_any_tagged_launch(monkeypatch):
    monkeypatch.setattr(app_leaks, "_ARMED", False)

    def boom(*_a, **_k):
        raise AssertionError("scanned the process table unarmed")

    monkeypatch.setattr(app_leaks, "find_leaked_apps", boom)
    assert app_leaks.reap_leaks("t") == []


def test_reap_kills_a_real_leaked_process_tree():
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        app_leaks.reap([psutil.Process(child.pid)], timeout=5.0)
        assert child.wait(timeout=10) is not None
    finally:
        if child.poll() is None:
            child.kill()


# ── Foreign apps on the desktop (#5467) ──────────────────────────────────────
def _foreign(procs, *, allowed=(), pids=(), ports=()):
    return [
        p.pid
        for p in app_leaks.find_foreign_apps(
            set(allowed), procs, live_pids=set(pids), live_ports={str(p) for p in ports}
        )
    ]


def test_any_other_termihub_is_foreign_whoever_launched_it():
    procs = [
        _Proc(40, "termihub", {app_leaks.OWNER_ENV: "1"}),  # a parallel worker's app
        _Proc(41, "termiHub", {}),  # untagged: an installed termiHub
        _Proc(42, "termihub.exe", {}, denied=True),  # unreadable env: still named
        _Proc(43, "bash", {}),  # not the app binary
    ]
    assert _foreign(procs) == [40, 41, 42]


def test_the_allowed_and_live_instances_are_not_foreign():
    procs = [_tagged(50, 6000), _tagged(51, 6001), _Proc(52, "termihub", {})]
    assert _foreign(procs, allowed=[52], pids=[50]) == [51]


def test_an_unadopted_relaunch_of_this_process_is_not_foreign():
    own = {app_leaks.OWNER_ENV: app_leaks.owner_tag(), BRIDGE_PORT_ENV: "6000"}
    other = {app_leaks.OWNER_ENV: "1", BRIDGE_PORT_ENV: "6000"}
    procs = [_Proc(60, "termihub", own), _Proc(61, "termihub", other)]
    assert _foreign(procs, pids=[59], ports=[6000]) == [61]


def test_a_leak_of_an_exited_session_is_named_as_gone():
    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait(timeout=10)
    line = app_leaks._owner_state(str(dead.pid), app_created=0.0)
    # Gone — or its PID reused by a process younger than the app: gone too.
    assert "gone" in line


def test_a_parallel_workers_app_is_named_as_alive():
    line = app_leaks._owner_state(str(psutil.Process().ppid()), app_created=None)
    assert "alive" in line


def test_owner_states_for_untagged_and_own_apps():
    assert "untagged" in app_leaks._owner_state(None, None)
    assert "this pytest process" in app_leaks._owner_state(app_leaks.owner_tag(), None)


def test_waiting_returns_nothing_once_the_foreign_app_exits():
    calls = []

    def find(allowed):
        calls.append(set(allowed))
        return [] if len(calls) > 2 else [psutil.Process()]

    assert app_leaks.wait_for_foreign_apps({7}, timeout=5.0, find=find, poll=0.01) == []
    assert calls[0] == {7} and len(calls) == 3


def test_waiting_names_a_foreign_app_that_never_exits():
    me = psutil.Process()
    lines = app_leaks.wait_for_foreign_apps({7}, timeout=0.05, find=lambda a: [me], poll=0.01)
    assert len(lines) == 1 and lines[0].startswith(f"pid={me.pid} ")


def test_describe_app_pid_is_empty_for_a_non_app():
    assert app_leaks.describe_app_pid(psutil.Process().pid) == ""
    assert app_leaks.describe_app_pid(2**31 - 2) == ""
