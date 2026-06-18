"""Unit tests for the name->element store lookups in termihub_harness.ui.

Machinery group (no app): a stub driver returns canned ``getState`` slices, so
these run anywhere without a build, like the protocol tests.
"""

import pytest

from termihub_harness import (
    find_connection,
    find_folder,
    find_tab,
    open_tabs,
    tab_count,
)
from termihub_harness.bridge import BridgeError
from termihub_harness.ui import connection_item_testid, folder_toggle_testid


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


def _panel(*tabs):
    return {"type": "leaf", "id": "leaf-1", "tabs": list(tabs)}


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
    # Before any connections exist the path may not resolve; helpers return empty
    # rather than raising, so a poll can simply keep waiting.
    driver = StubDriver({})
    assert find_connection(driver, "x") is None
    assert find_folder(driver, "x") is None
    assert open_tabs(driver) == []
    assert tab_count(driver) == 0


def test_open_tabs_flattens_a_split_panel_tree():
    driver = StubDriver(
        {
            "rootPanel": {
                "type": "split",
                "children": [
                    _panel({"id": "t1", "title": "bash"}),
                    {
                        "type": "split",
                        "children": [_panel({"id": "t2", "title": "Edit: prod"})],
                    },
                ],
            }
        }
    )
    titles = [t["title"] for t in open_tabs(driver)]
    assert titles == ["bash", "Edit: prod"]
    assert tab_count(driver) == 2


def test_find_tab_matches_a_title_substring():
    driver = StubDriver({"rootPanel": _panel({"id": "t2", "title": "Edit: prod-server"})})
    assert find_tab(driver, "Edit")["id"] == "t2"
    assert find_tab(driver, "Ping") is None


@pytest.mark.parametrize(
    "builder,value,expected",
    [
        (connection_item_testid, "abc", "connection-item-abc"),
        (folder_toggle_testid, "f1", "folder-toggle-f1"),
    ],
)
def test_testid_builders(builder, value, expected):
    assert builder(value) == expected
