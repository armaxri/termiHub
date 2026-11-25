"""Machinery tests: a rerun loses no fixture's teardown (#6046).

The real pytest-rerunfailures runs in a subprocess over a throwaway suite: every
app its fixture starts must be stopped, whichever attempt started it. No
``integration`` marker.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

from termihub_harness import rerun_finalizers

HARNESS_DIR = Path(__file__).resolve().parents[1]

SUITE = """
import os
import pytest

FAIL_SETUP = eval(os.environ["FAIL_SETUP"])
FAIL_CALL = eval(os.environ["FAIL_CALL"])
seen = {"host": 0, "call": 0, "app": 0}


def event(text):
    print("EVENT " + text, flush=True)


@pytest.fixture(scope="session")
def host():
    seen["host"] += 1
    if seen["host"] in FAIL_SETUP:
        raise RuntimeError("host")
    event("host up")
    yield
    event("host down")


class Suite:
    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def _app(cls):
        seen["app"] += 1
        n = seen["app"]
        event(f"app {n} up")
        yield
        event(f"app {n} down")


@pytest.mark.usefixtures("host")
class TestFirst(Suite):
    def test_one(self):
        seen["call"] += 1
        assert seen["call"] not in FAIL_CALL

    def test_two(self):
        pass


class TestSecond(Suite):
    def test_three(self):
        event("second suite")
"""

CONFTEST = """
import sys
sys.path.insert(0, {harness!r})
import pytest_rerunfailures
from termihub_harness import rerun_finalizers
assert rerun_finalizers.install(pytest_rerunfailures)
"""


def _events(tmp_path: Path, fail_setup: str, fail_call: str) -> list[str]:
    (tmp_path / "test_suite.py").write_text(textwrap.dedent(SUITE), encoding="utf-8")
    (tmp_path / "conftest.py").write_text(
        CONFTEST.format(harness=str(HARNESS_DIR)), encoding="utf-8"
    )
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTEST_")}
    env.update(FAIL_SETUP=fail_setup, FAIL_CALL=fail_call)
    done = subprocess.run(
        [
            sys.executable,
            *("-m", "pytest", "-q", "-s", "-p", "no:cacheprovider"),
            *("--reruns", "2", "--rootdir", str(tmp_path), str(tmp_path)),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert "INTERNALERROR" not in done.stdout + done.stderr, done.stdout + done.stderr
    # A progress letter can stand before the event on the same line.
    return [
        line.split("EVENT ", 1)[1] for line in done.stdout.splitlines() if "EVENT " in line
    ]


@pytest.mark.parametrize(
    ("fail_setup", "fail_call"),
    [
        ("()", "()"),
        ("(1,)", "()"),  # the nightly: the app comes up in the second attempt
        ("(1, 2)", "()"),
        ("()", "(1,)"),
        ("()", "(1, 2, 3)"),
        ("(1,)", "(1,)"),
        ("(1, 2, 3)", "()"),
    ],
)
def test_every_app_that_comes_up_goes_down_once(tmp_path, fail_setup, fail_call):
    events = _events(tmp_path, fail_setup, fail_call)
    up = [e.removesuffix(" up") for e in events if e.startswith("app") and e.endswith(" up")]
    down = [e.removesuffix(" down") for e in events if e.startswith("app") and e.endswith(" down")]
    assert up and sorted(up) == sorted(down), events
    # The first suite's app is gone before the second suite's comes up.
    assert events.index(f"{up[-2]} down") < events.index(f"{up[-1]} up"), events
    assert events.count("host up") == events.count("host down"), events


def test_merge_keeps_order_and_drops_what_both_attempts_registered():
    def node_teardown():
        pass

    first, second = object(), object()
    older = ([node_teardown, first], None)
    newer = ([node_teardown, second], "error")
    assert rerun_finalizers.merge(older, newer) == ([node_teardown, first, second], "error")


def test_a_plugin_without_these_parts_is_left_alone():
    assert rerun_finalizers.install(SimpleNamespace()) is False
