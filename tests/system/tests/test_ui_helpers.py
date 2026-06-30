"""Unit tests for the name->element store lookups in termihub_harness.ui.

Machinery group (no app): a stub driver returns canned ``getState`` slices, so
these run anywhere without a build, like the protocol tests.
"""

import pytest

from termihub_harness import find_connection, find_folder
from termihub_harness.bridge import BridgeError
from termihub_harness.ui import connection_item_testid, folder_toggle_testid, iter_tabs
from termihub_harness.ui.base import HarnessMixin


class StubDriver:
    """Minimal Driver stand-in: serves ``get_state(path)`` from a dict of slices."""

    def __init__(self, state: dict):
        self._state = state

    def get_state(self, path=None):
        if path is None:
            return self._state
        if path not in self._state:
            raise BridgeError("getState", f'state path "{path}" does not resolve')
        return self._state[path]


class MenuDriver:
    """Driver stub for ``open_named_context_menu``: tracks ``exists``/``context_menu``.

    The sentinel testid only starts to "exist" *after* ``context_menu`` is
    dispatched on the trigger, mirroring the real app: a right-click is what
    mounts the menu (and therefore its sentinel item).
    """

    def __init__(self, *, present, sentinel):
        self._present = set(present)
        self._sentinel = sentinel
        self.context_menu_calls: list[str] = []

    def exists(self, test_id: str) -> bool:
        return test_id in self._present

    def context_menu(self, test_id: str) -> None:
        self.context_menu_calls.append(test_id)
        self._present.add(self._sentinel)


class FakeHarness(HarnessMixin):
    """Concrete ``HarnessMixin`` with an eager ``wait`` for unit tests (no app).

    ``wait`` polls the predicate synchronously up to ``_MAX_POLLS`` times — the
    mutable ``MenuDriver`` / closure state flips truthy within a few polls, so no
    real timing is involved.
    """

    _MAX_POLLS = 50

    def __init__(self, driver):
        self.driver = driver

    def wait(self, predicate, *, timeout=0, interval=0, what=""):
        for _ in range(self._MAX_POLLS):
            result = predicate()
            if result:
                return result
        raise AssertionError(f"timed out waiting for {what}")


def test_find_connection_matches_by_name():
    driver = StubDriver(
        {"connections": [{"id": "a", "name": "prod"}, {"id": "b", "name": "dev"}]}
    )
    assert find_connection(driver, "dev") == {"id": "b", "name": "dev"}
    assert find_connection(driver, "missing") is None


def test_find_folder_matches_by_name():
    driver = StubDriver({"folders": [{"id": "f1", "name": "work"}]})
    assert find_folder(driver, "work")["id"] == "f1"
    assert find_folder(driver, "home") is None


def test_lookups_are_resilient_to_unresolved_state():
    # Before any connections exist the path may not resolve; helpers return None
    # rather than raising, so a poll can simply keep waiting.
    driver = StubDriver({})
    assert find_connection(driver, "x") is None
    assert find_folder(driver, "x") is None


@pytest.mark.parametrize(
    "builder,value,expected",
    [
        (connection_item_testid, "abc", "connection-item-abc"),
        (folder_toggle_testid, "f1", "folder-toggle-f1"),
    ],
)
def test_testid_builders(builder, value, expected):
    assert builder(value) == expected


def test_open_named_context_menu_dispatches_on_the_resolved_trigger():
    # Item resolves to id "1"; its trigger is mounted, so the menu is dispatched
    # exactly once on that trigger and the helper returns when the sentinel mounts.
    driver = MenuDriver(present={"trigger-1"}, sentinel="ctx-edit")
    harness = FakeHarness(driver)
    harness.open_named_context_menu(
        resolve=lambda: {"id": "1"},
        testid_for=lambda item_id: f"trigger-{item_id}",
        sentinel="ctx-edit",
        what="the menu",
    )
    assert driver.context_menu_calls == ["trigger-1"]


def test_open_named_context_menu_waits_for_resolve_then_a_mounted_trigger():
    # First poll: item unresolved. Then resolved but its trigger not yet in the
    # DOM. Only once both hold is the right-click dispatched — never on a stale id.
    driver = MenuDriver(present=set(), sentinel="ctx-edit")
    harness = FakeHarness(driver)
    polls = {"n": 0}

    def resolve():
        polls["n"] += 1
        if polls["n"] == 1:
            return None  # store not loaded yet
        if polls["n"] == 2:
            return {"id": "9"}  # resolved, but trigger still unmounted (below)
        driver._present.add("trigger-9")  # trigger mounts from the 3rd poll on
        return {"id": "9"}

    harness.open_named_context_menu(
        resolve=resolve,
        testid_for=lambda item_id: f"trigger-{item_id}",
        sentinel="ctx-edit",
        what="the menu",
    )
    assert driver.context_menu_calls == ["trigger-9"]


def test_iter_tabs_flattens_a_split_tree_in_order():
    # A horizontal split of two leaves, each with its own tabs.
    root = {
        "type": "split",
        "children": [
            {"type": "leaf", "id": "p1", "tabs": [{"id": "a"}, {"id": "b"}]},
            {"type": "leaf", "id": "p2", "tabs": [{"id": "c"}]},
        ],
    }
    assert [tab["id"] for tab in iter_tabs(root)] == ["a", "b", "c"]


def test_iter_tabs_handles_a_single_leaf_and_empty_or_malformed_nodes():
    one_leaf = {"type": "leaf", "id": "p1", "tabs": [{"id": "x"}]}
    assert [tab["id"] for tab in iter_tabs(one_leaf)] == ["x"]
    # A partially-built tree (mid-restart) yields whatever it has, never raises.
    assert iter_tabs({"type": "leaf", "id": "p1"}) == []
    assert iter_tabs({"type": "leaf", "id": "p1", "tabs": []}) == []
    assert iter_tabs(None) == []
    assert iter_tabs({"type": "split", "children": [None, "junk"]}) == []
