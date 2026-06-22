"""Unit tests for the name->element store lookups in termihub_harness.ui.

Machinery group (no app): a stub driver returns canned ``getState`` slices, so
these run anywhere without a build, like the protocol tests.
"""

import pytest

from termihub_harness import find_connection, find_folder
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
