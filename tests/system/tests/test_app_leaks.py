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
