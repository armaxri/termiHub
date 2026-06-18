"""UI-level helpers shared by the ported integration suites (issue #807+).

The bridge addresses elements by ``data-testid``, but connection items, folders,
and tabs carry **UUID** testids that a test cannot know up front. These helpers
resolve a stable *name* to its element by reading the Zustand store through
``getState`` — the bridge-native analog of the WebdriverIO suites' find-by-title
lookup. The connection-list **flows** live in :class:`ConnectionsUi`, a mixin for
suites that also subclass :class:`~termihub_harness.SystemTest` (it relies on the
base's ``self.driver`` and ``self.wait``).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Iterator, Optional, TypeVar

from .bridge import BridgeError, Driver

_T = TypeVar("_T")


# ── State lookups (no polling) ─────────────────────────────────────────────────
def _state_list(driver: Driver, path: str) -> list[dict[str, Any]]:
    """Read a top-level array of objects from the store, or ``[]`` if unresolved."""
    try:
        value = driver.get_state(path)
    except BridgeError:
        return []
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


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


def _iter_leaf_tabs(node: Any) -> Iterator[dict[str, Any]]:
    """Yield every tab across the panel tree's leaves, depth-first."""
    if not isinstance(node, dict):
        return
    if node.get("type") == "leaf":
        for tab in node.get("tabs") or []:
            if isinstance(tab, dict):
                yield tab
    for child in node.get("children") or []:
        yield from _iter_leaf_tabs(child)


def open_tabs(driver: Driver) -> list[dict[str, Any]]:
    """Every open tab in the active panel group (id, title, …)."""
    try:
        root = driver.get_state("rootPanel")
    except BridgeError:
        return []
    return list(_iter_leaf_tabs(root))


def tab_count(driver: Driver) -> int:
    """How many tabs are open across the active panel group."""
    return len(open_tabs(driver))


def find_tab(driver: Driver, title_substring: str) -> Optional[dict[str, Any]]:
    """The first open tab whose title contains ``title_substring``, or ``None``."""
    return next(
        (t for t in open_tabs(driver) if title_substring in str(t.get("title", ""))),
        None,
    )


def connection_item_testid(connection_id: str) -> str:
    """The ``data-testid`` of the sidebar item for a connection id."""
    return f"connection-item-{connection_id}"


def folder_toggle_testid(folder_id: str) -> str:
    """The ``data-testid`` of the sidebar toggle for a folder id."""
    return f"folder-toggle-{folder_id}"


# ── Connection-list flows (mixin for SystemTest suites) ────────────────────────
class ConnectionsUi:
    """Connection-list interactions for suites that also subclass ``SystemTest``.

    Methods reuse the base class's ``self.driver`` (the live bridge) and
    ``self.wait`` (poll-until-truthy, retrying on ``BridgeError``), so each flow
    waits out the async sidebar/editor re-renders instead of sleeping.
    """

    # Stable connection-list / editor testids (UUID-free).
    NEW_CONNECTION = "connection-list-new-connection"
    NEW_FOLDER = "connection-list-new-folder"
    FOLDER_NAME_INPUT = "inline-folder-name-input"
    FOLDER_CONFIRM = "inline-folder-confirm"
    EDITOR_NAME = "connection-editor-name-input"
    EDITOR_TYPE = "connection-editor-type-select"
    EDITOR_SAVE = "connection-editor-save"
    EDITOR_SAVE_CONNECT = "connection-editor-save-connect"
    EDITOR_CANCEL = "connection-editor-cancel"
    EDITOR_NAME_ERROR = "connection-editor-name-error"

    # Connection context-menu item testids.
    CTX_EDIT = "context-connection-edit"
    CTX_DUPLICATE = "context-connection-duplicate"
    CTX_DELETE = "context-connection-delete"
    CTX_PING = "context-connection-ping"

    # Supplied by SystemTest, with which this mixin is always combined (it sits
    # first in the MRO, so these are declared for type-checkers only — defining
    # `wait` for real here would shadow the base implementation).
    driver: Driver
    if TYPE_CHECKING:

        def wait(
            self,
            predicate: Callable[[], _T],
            *,
            timeout: float = ...,
            interval: float = ...,
            what: str = ...,
        ) -> _T: ...

    # -- lookups -----------------------------------------------------------------
    def find_connection(self, name: str) -> Optional[dict[str, Any]]:
        return find_connection(self.driver, name)

    def find_folder(self, name: str) -> Optional[dict[str, Any]]:
        return find_folder(self.driver, name)

    def require_connection(self, name: str) -> dict[str, Any]:
        """Wait until a connection named ``name`` exists in the store, returning it."""
        return self.wait(lambda: self.find_connection(name), what=f"connection {name!r}")

    # -- sidebar -----------------------------------------------------------------
    ACTIVITY_BAR_CONNECTIONS = "activity-bar-connections"

    def ensure_connections_sidebar(self) -> None:
        """Make sure the Connections sidebar (with its New buttons) is showing."""
        if not self.driver.exists(self.NEW_CONNECTION):
            self.driver.click(self.ACTIVITY_BAR_CONNECTIONS)
        self.wait(
            lambda: self.driver.exists(self.NEW_CONNECTION),
            what="the connections sidebar",
        )

    # -- editor ------------------------------------------------------------------
    def open_new_connection_editor(self) -> None:
        """Open the New Connection editor and wait for its name field."""
        self.driver.click(self.NEW_CONNECTION)
        self.wait(lambda: self.driver.exists(self.EDITOR_NAME), what="the connection editor")

    def editor_open(self) -> bool:
        """Whether the connection editor name field is currently present."""
        return self.driver.exists(self.EDITOR_NAME)

    def create_local_connection(self, name: str) -> str:
        """Create and save a local-shell connection (the default type)."""
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE)
        self.require_connection(name)
        return name

    def create_typed_connection(self, name: str, conn_type: str, fields: dict[str, str]) -> str:
        """Create a connection of ``conn_type``, filling DynamicForm ``field-*`` inputs."""
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.select_option(self.EDITOR_TYPE, conn_type)
        for key, value in fields.items():
            self.wait(
                lambda key=key: self.driver.exists(f"field-{key}"),
                what=f"the {key!r} field",
            )
            self.driver.type(f"field-{key}", value)
        self.driver.click(self.EDITOR_SAVE)
        self.require_connection(name)
        return name

    # -- context menu ------------------------------------------------------------
    def open_connection_menu(self, name: str) -> None:
        """Right-click a connection by name and wait for its menu to mount."""
        conn = self.require_connection(name)
        item = connection_item_testid(conn["id"])

        def right_click_and_check() -> bool:
            # Re-dispatch each poll: a single right-click can race the item's
            # mount/handler, so retrying the gesture is what makes it reliable.
            self.driver.context_menu(item)
            return self.driver.exists(self.CTX_EDIT)

        self.wait(right_click_and_check, what="the connection context menu")

    def connection_context_action(self, name: str, action_test_id: str) -> None:
        """Right-click a connection by name and click a context-menu action."""
        self.open_connection_menu(name)
        self.driver.click(action_test_id)

    def dismiss_menu(self) -> None:
        """Close any open context menu / dialog via Escape."""
        self.driver.press_key("Escape")
