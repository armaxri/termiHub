"""Unit tests for the name->element store lookups in termihub_harness.ui.

Machinery group (no app): a stub driver returns canned ``getState`` slices, so
these run anywhere without a build, like the protocol tests.
"""

import pytest

from termihub_harness import find_connection, find_folder
from termihub_harness.bridge import BridgeError
from termihub_harness.ui import (
    active_leaf,
    connection_item_testid,
    find_leaf,
    folder_toggle_testid,
    iter_tabs,
)
from termihub_harness.ui.base import HarnessMixin
from termihub_harness.ui.tabs import TabsUi


class StubDriver:
    """Minimal Driver stand-in: serves ``get_state(path)`` slices and projection
    region caches.

    ``get_state`` reads the ``state`` dict (used by the panel-tree lookups).
    ``regions`` maps a region id to its projected cache dict, served through the
    ``projection_subscribe``/``projection_state`` pair the connections/folders
    lookups now use — those slices are region-authoritative, so ``get_state`` no
    longer resolves them.
    """

    def __init__(self, state: dict | None = None, *, regions: dict | None = None):
        self._state = state or {}
        self._regions = regions or {}

    def get_state(self, path=None):
        if path is None:
            return self._state
        if path not in self._state:
            raise BridgeError("getState", f'state path "{path}" does not resolve')
        return self._state[path]

    def projection_subscribe(self, region):
        return {"subscriptionId": f"sub-{region}", "region": region}

    def projection_state(self, subscription_id):
        region = subscription_id.removeprefix("sub-")
        # Mirror the real substrate: the recorded cache is the ``{version, view}``
        # ProjectionClient envelope, so the view document is nested under "view".
        return {"cache": {"version": 1, "view": self._regions.get(region, {})}}


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
    # The connections region cache holds both lists (the ConnectionsView twin);
    # find_connection reads its "connections" list.
    driver = StubDriver(
        regions={
            "connections": {
                "connections": [{"id": "a", "name": "prod"}, {"id": "b", "name": "dev"}]
            }
        }
    )
    assert find_connection(driver, "dev") == {"id": "b", "name": "dev"}
    assert find_connection(driver, "missing") is None


def test_find_folder_matches_by_name():
    driver = StubDriver(regions={"connections": {"folders": [{"id": "f1", "name": "work"}]}})
    assert find_folder(driver, "work")["id"] == "f1"
    assert find_folder(driver, "home") is None


def test_lookups_are_resilient_to_unresolved_state():
    # Before any connections exist the region cache is empty; helpers return None
    # rather than raising, so a poll can simply keep waiting.
    driver = StubDriver()
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
    poll = 0

    def resolve():
        nonlocal poll
        poll += 1
        if poll == 1:
            return None  # store not loaded yet
        if poll == 2:
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


class TabDriver:
    """Driver stub for tab switching: serves ``get_state`` for the panel tree and
    ``activePanelId``, and flips a leaf's ``activeTabId`` when its tab is clicked.

    Clicking ``tab-<id>`` mirrors the real app: the clicked tab becomes the active
    tab of whichever leaf contains it, so ``active_tab()`` then reflects it.
    """

    def __init__(self, root: dict, active_panel_id: str):
        self._root = root
        self._active_panel_id = active_panel_id
        self.clicks: list[str] = []

    def get_state(self, path=None):
        if path == "rootPanel":
            return self._root
        if path == "activePanelId":
            return self._active_panel_id
        raise BridgeError("getState", f'state path "{path}" does not resolve')

    def click(self, test_id: str) -> None:
        self.clicks.append(test_id)
        if not test_id.startswith("tab-"):
            return
        tab_id = test_id[len("tab-") :]

        def activate(node):
            if not isinstance(node, dict):
                return
            if node.get("type") == "leaf":
                if any(t.get("id") == tab_id for t in node.get("tabs") or []):
                    node["activeTabId"] = tab_id
                return
            for child in node.get("children") or []:
                activate(child)

        activate(self._root)


class FakeTabs(TabsUi):
    """``TabsUi`` with an eager, app-free ``wait`` (same pattern as FakeHarness)."""

    _MAX_POLLS = 50

    def __init__(self, driver):
        self.driver = driver

    def wait(self, predicate, *, timeout=0, interval=0, what=""):
        for _ in range(self._MAX_POLLS):
            result = predicate()
            if result:
                return result
        raise AssertionError(f"timed out waiting for {what}")


def test_switch_to_terminal_tab_activates_the_open_terminal():
    # An editor tab is active alongside an open terminal tab. Switching must
    # click the *terminal* tab (by contentType) and leave it the active tab —
    # ``ensure_terminal`` would not have changed the active tab at all.
    root = {
        "type": "leaf",
        "id": "p1",
        "activeTabId": "ed",
        "tabs": [
            {"id": "ed", "contentType": "editor"},
            {"id": "term", "contentType": "terminal"},
        ],
    }
    driver = TabDriver(root, "p1")
    tabs = FakeTabs(driver)
    result = tabs.switch_to_terminal_tab()
    assert result["id"] == "term"
    assert driver.clicks == ["tab-term"]
    assert tabs.active_tab()["id"] == "term"


def test_switch_to_terminal_tab_raises_when_no_terminal_is_open():
    root = {
        "type": "leaf",
        "id": "p1",
        "activeTabId": "ed",
        "tabs": [{"id": "ed", "contentType": "editor"}],
    }
    tabs = FakeTabs(TabDriver(root, "p1"))
    with pytest.raises(AssertionError):
        tabs.switch_to_terminal_tab()


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


_SPLIT_TREE = {
    "type": "split",
    "children": [
        {"type": "leaf", "id": "p1", "tabs": [{"id": "a"}]},
        {"type": "leaf", "id": "p2", "tabs": []},
    ],
}


def test_find_leaf_locates_a_leaf_by_id_or_returns_none():
    assert find_leaf(_SPLIT_TREE, "p1")["tabs"] == [{"id": "a"}]
    assert find_leaf(_SPLIT_TREE, "p2")["tabs"] == []
    assert find_leaf(_SPLIT_TREE, "missing") is None
    # Malformed / partial nodes never raise.
    assert find_leaf(None, "p1") is None
    assert find_leaf({"type": "split", "children": [None, "junk"]}, "p1") is None


def test_active_leaf_returns_the_active_panels_leaf():
    # The freshly-split active panel (#1656) is empty while the other holds a tab.
    driver = StubDriver({"activePanelId": "p2", "rootPanel": _SPLIT_TREE})
    assert active_leaf(driver) == {"type": "leaf", "id": "p2", "tabs": []}


def test_active_leaf_is_none_when_unresolved():
    # No active panel, or a tree that hasn't loaded yet (BridgeError) → None.
    assert active_leaf(StubDriver({"activePanelId": None, "rootPanel": _SPLIT_TREE})) is None
    assert active_leaf(StubDriver({"rootPanel": _SPLIT_TREE})) is None
    assert active_leaf(StubDriver({"activePanelId": "p1"})) is None
