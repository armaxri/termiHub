"""Name->element store lookups shared by the ported UI suites (issue #807+).

The bridge addresses elements by ``data-testid``, but connection items and
folders carry **UUID** testids a test cannot know up front. These helpers resolve
a stable *name* to its element by reading the connections-tree state — the
bridge-native analog of the WebdriverIO suites' find-by-title lookup. They are
plain functions (no polling, no app) so they stay unit-testable against the
``StubDriver`` in ``test_ui_helpers.py``.

The connections domain is **region-authoritative** since the Phase-5 reducer
removal: ``appStore`` no longer holds a ``connections`` / ``folders`` slice, so a
``get_state("connections")`` / ``get_state("folders")`` read no longer resolves.
The data now lives in the ``connections`` projection region, whose cache is the
``ConnectionsView`` twin — a single region holding both lists,
``{"folders": [...], "connections": [...]}`` (``ConnectionsStore::snapshot`` /
``src/store/connectionsBridge.ts``). These lookups read that region cache instead,
the same way :meth:`HarnessMixin.projection_region_cache` does for the ``settings``
/ ``agents`` domains.
"""

from __future__ import annotations

from typing import Any, Optional

from ..bridge import BridgeError, Driver

#: Projection region id for the connections-tree domain (twin of the frontend
#: ``CONNECTIONS_REGION`` const in ``src/store/connectionsBridge.ts``). Its cache
#: is the ``ConnectionsView``: both the folder list and the saved-connection list
#: live in this one region, keyed ``"folders"`` / ``"connections"``.
CONNECTIONS_REGION = "connections"


# ── State lookups (no polling) ─────────────────────────────────────────────────
def _region_cache(driver: Driver, region: str) -> dict[str, Any]:
    """The current projected cache dict of a ``region``, read through the substrate.

    Free-function twin of :meth:`HarnessMixin.projection_region_cache` (the
    lookups take a bare :class:`Driver`, not a ``HarnessMixin`` ``self``). The
    subscription is memoised on the driver so a polled lookup reuses one
    subscription for the whole app lifetime instead of leaking one per poll; the
    driver is recreated with the app (and on restart), so the memo never outlives
    its subscription. Returns ``{}`` when the region has no cache yet, so a
    ``.get(...)`` on the result is always safe.
    """
    subs = getattr(driver, "_lookup_region_subs", None)
    if subs is None:
        subs = {}
        driver._lookup_region_subs = subs  # type: ignore[attr-defined]
    sub_id = subs.get(region)
    if sub_id is None:
        sub_id = driver.projection_subscribe(region)["subscriptionId"]
        subs[region] = sub_id
    cache = driver.projection_state(sub_id).get("cache")
    # The substrate records the ProjectionClient state as ``{version, view}``;
    # callers read *document* fields (``.get("connections")`` / ``"folders"``), so
    # unwrap the ``view`` document — never the ``{version, view}`` envelope, on
    # which those keys would always be absent (the A2 fix, #2628, for the shared
    # HarnessMixin.projection_region_cache twin).
    view = cache.get("view") if isinstance(cache, dict) else None
    return view if isinstance(view, dict) else {}


def _region_list(driver: Driver, region: str, key: str) -> list[dict[str, Any]]:
    """Read a top-level array of objects from a region's cache, or ``[]``."""
    value = _region_cache(driver, region).get(key)
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def connections(driver: Driver) -> list[dict[str, Any]]:
    """Every saved connection in the store (id, name, config, …)."""
    return _region_list(driver, CONNECTIONS_REGION, "connections")


def find_connection(driver: Driver, name: str) -> Optional[dict[str, Any]]:
    """The saved connection whose name equals ``name``, or ``None``."""
    return next((c for c in connections(driver) if c.get("name") == name), None)


def folders(driver: Driver) -> list[dict[str, Any]]:
    """Every connection folder in the store (id, name, parentId, …)."""
    return _region_list(driver, CONNECTIONS_REGION, "folders")


def find_folder(driver: Driver, name: str) -> Optional[dict[str, Any]]:
    """The folder whose name equals ``name``, or ``None``."""
    return next((f for f in folders(driver) if f.get("name") == name), None)


def iter_tabs(root: Any) -> list[dict[str, Any]]:
    """Flatten every tab dict in a panel tree (depth-first, in tree order).

    The app exposes its layout via ``getState("rootPanel")`` — a tree of split
    nodes (``children``) and ``leaf`` panels (``tabs``). This walks it into a flat
    tab list shared by the tab and terminal helpers, so neither re-implements the
    traversal. A non-dict / unexpected node is skipped rather than raising, so a
    partially-built tree (mid-restart) yields whatever tabs it already has.
    """
    tabs: list[dict[str, Any]] = []

    def walk(node: Any) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == "leaf":
            tabs.extend(tab for tab in (node.get("tabs") or []) if isinstance(tab, dict))
        else:
            for child in node.get("children") or []:
                walk(child)

    walk(root)
    return tabs


def find_leaf(root: Any, leaf_id: str) -> Optional[dict[str, Any]]:
    """The ``leaf`` panel dict with ``id == leaf_id`` in a panel tree, or ``None``.

    Mirrors the app's ``findLeaf`` over the ``getState("rootPanel")`` tree so the
    harness can reason about a *specific* panel (e.g. the active one) rather than
    the flattened tab list :func:`iter_tabs` returns.
    """
    if not isinstance(root, dict):
        return None
    if root.get("type") == "leaf":
        return root if root.get("id") == leaf_id else None
    for child in root.get("children") or []:
        found = find_leaf(child, leaf_id)
        if found is not None:
            return found
    return None


def active_leaf(driver: Driver) -> Optional[dict[str, Any]]:
    """The currently-active leaf panel (``activePanelId`` in ``rootPanel``), or ``None``.

    This is the panel ``addTab`` and terminal input actually target, so it is the
    panel a test must reason about after a split — where the freshly-created,
    *active* panel is empty while other panels still hold terminals (#1656).
    """
    try:
        active_id = driver.get_state("activePanelId")
        root = driver.get_state("rootPanel")
    except BridgeError:
        return None
    if not active_id:
        return None
    return find_leaf(root, active_id)


def connection_item_testid(connection_id: str) -> str:
    """The ``data-testid`` of the sidebar item for a connection id."""
    return f"connection-item-{connection_id}"


def folder_toggle_testid(folder_id: str) -> str:
    """The ``data-testid`` of the sidebar toggle for a folder id."""
    return f"folder-toggle-{folder_id}"
