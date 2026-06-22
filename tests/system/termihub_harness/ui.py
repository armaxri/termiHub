"""Connection-list helpers shared by the ported UI suites (issue #807+).

The bridge addresses elements by ``data-testid``, but connection items and
folders carry **UUID** testids a test cannot know up front. These helpers
resolve a stable *name* to its element by reading the Zustand store through
``getState`` — the bridge-native analog of the WebdriverIO suites' find-by-title
lookup.

The connection-list **flows** live in :class:`ConnectionsUi`, a focused mixin for
suites that also subclass :class:`~termihub_harness.SystemTest`. It builds on the
base's generic helpers — ``self.driver``, ``self.wait``, ``self.find_tab`` /
``self.tab_count``, ``self.open_new_connection_editor``,
``self.create_ssh_connection``, ``self.switch_to_connections_sidebar`` — and only
adds what is specific to the connection list (create/find/duplicate/context-menu).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Optional, TypeVar

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
    NEW_FOLDER = "connection-list-new-folder"
    FOLDER_NAME_INPUT = "inline-folder-name-input"
    FOLDER_CONFIRM = "inline-folder-confirm"
    EDITOR_NAME = "connection-editor-name-input"
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
    # them for real here would shadow the base implementations).
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

        def open_new_connection_editor(self) -> None: ...

    # -- lookups -----------------------------------------------------------------
    def find_connection(self, name: str) -> Optional[dict[str, Any]]:
        return find_connection(self.driver, name)

    def find_folder(self, name: str) -> Optional[dict[str, Any]]:
        return find_folder(self.driver, name)

    def require_connection(self, name: str) -> dict[str, Any]:
        """Wait until a connection named ``name`` exists in the store, returning it."""
        return self.wait(lambda: self.find_connection(name), what=f"connection {name!r}")

    # -- editor ------------------------------------------------------------------
    def editor_open(self) -> bool:
        """Whether the connection editor name field is currently present."""
        return self.driver.exists(self.EDITOR_NAME)

    def create_local_connection(self, name: str) -> str:
        """Create and save a local-shell connection (the default editor type)."""
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
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
