"""Name->element store lookups shared by the ported UI suites (issue #807+).

The bridge addresses elements by ``data-testid``, but connection items and
folders carry **UUID** testids a test cannot know up front. These helpers resolve
a stable *name* to its element by reading the Zustand store through ``getState``
— the bridge-native analog of the WebdriverIO suites' find-by-title lookup. They
are plain functions (no polling, no app) so they stay unit-testable against the
``StubDriver`` in ``test_ui_helpers.py``.
"""

from __future__ import annotations

from typing import Any, Optional

from ..bridge import BridgeError, Driver


# ── State lookups (no polling) ─────────────────────────────────────────────────
def _state_list(driver: Driver, path: str) -> list[dict[str, Any]]:
    """Read a top-level array of objects from the store, or ``[]`` if unresolved."""
    try:
        value = driver.get_state(path)
    except BridgeError:
        return []
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def connections(driver: Driver) -> list[dict[str, Any]]:
    """Every saved connection in the store (id, name, config, …)."""
    return _state_list(driver, "connections")


def find_connection(driver: Driver, name: str) -> Optional[dict[str, Any]]:
    """The saved connection whose name equals ``name``, or ``None``."""
    return next((c for c in connections(driver) if c.get("name") == name), None)


def folders(driver: Driver) -> list[dict[str, Any]]:
    """Every connection folder in the store (id, name, parentId, …)."""
    return _state_list(driver, "folders")


def find_folder(driver: Driver, name: str) -> Optional[dict[str, Any]]:
    """The folder whose name equals ``name``, or ``None``."""
    return next((f for f in folders(driver) if f.get("name") == name), None)


def connection_item_testid(connection_id: str) -> str:
    """The ``data-testid`` of the sidebar item for a connection id."""
    return f"connection-item-{connection_id}"


def folder_toggle_testid(folder_id: str) -> str:
    """The ``data-testid`` of the sidebar toggle for a folder id."""
    return f"folder-toggle-{folder_id}"
