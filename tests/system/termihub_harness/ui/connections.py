"""Connection-editor and connection-list flows (issues #807, #812 → #831).

``ConnectionsUi`` owns everything that drives the connection editor and the
connection-list sidebar: opening the editor, creating local/SSH connections, and
the list's find/duplicate/context-menu flows. It resolves a stable *name* to its
UUID-keyed sidebar element through the store lookups in
:mod:`~termihub_harness.ui.lookups`.

Methods reuse the base class's ``self.driver`` (the live bridge) and ``self.wait``
(poll-until-truthy, retrying on ``BridgeError``), so each flow waits out the async
sidebar/editor re-renders instead of sleeping.
"""

from __future__ import annotations

from typing import Any, Optional

from .base import HarnessMixin
from .lookups import connection_item_testid, find_connection, find_folder


class ConnectionsUi(HarnessMixin):
    """Connection-editor + connection-list interactions for ``SystemTest`` suites."""

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

    # -- lookups -----------------------------------------------------------------
    def find_connection(self, name: str) -> Optional[dict[str, Any]]:
        return find_connection(self.driver, name)

    def find_folder(self, name: str) -> Optional[dict[str, Any]]:
        return find_folder(self.driver, name)

    def require_connection(self, name: str) -> dict[str, Any]:
        """Wait until a connection named ``name`` exists in the store, returning it."""
        return self.wait(lambda: self.find_connection(name), what=f"connection {name!r}")

    def require_stable_connection(self, name: str) -> dict[str, Any]:
        """Wait until a connection exists with its *settled* (persisted) id.

        The editor assigns an optimistic ``conn-<timestamp>`` id when it saves; the
        backend then reloads from disk and replaces it with the path-based persisted
        id (``compute_connection_id`` → the name for a top-level connection). A flow
        that keys something on the id — e.g. a saved credential, for a
        reuse-on-reconnect test — must wait for that swap, or it stores under the
        soon-to-be-replaced optimistic id and orphans it. Returns the connection
        once its id is no longer the ``conn-`` optimistic placeholder.
        """

        def settled() -> Optional[dict[str, Any]]:
            conn = self.find_connection(name)
            if conn is None or str(conn["id"]).startswith("conn-"):
                return None
            return conn

        return self.wait(settled, what=f"connection {name!r} id to settle")

    # -- editor ------------------------------------------------------------------
    def editor_open(self) -> bool:
        """Whether the connection editor name field is currently present."""
        return self.driver.exists(self.EDITOR_NAME)

    def open_new_connection_editor(self) -> None:
        """Open a fresh connection editor and wait for its name field."""
        self.driver.click("connection-list-new-connection")
        self.wait(
            lambda: self.driver.exists("connection-editor-name-input"),
            what="the connection editor",
        )

    def _try_select(self, test_id: str, value: str) -> bool:
        """``driver.select`` that returns True, for use as a :meth:`wait` predicate.

        A native ``<select>`` whose options load asynchronously raises a
        ``BridgeError`` ("option … not found") until the option exists; wrapping
        the call lets :meth:`wait` retry until it succeeds.
        """
        self.driver.select(test_id, value)
        return True

    def create_local_connection(self, name: str) -> str:
        """Create and save a local-shell connection (the default editor type)."""
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self.driver.click(self.EDITOR_SAVE)
        self.require_connection(name)
        return name

    def create_ssh_connection(
        self,
        name: str,
        *,
        host: str,
        port: int,
        username: str,
        auth_method: str = "password",
        key_path: Optional[str] = None,
        save_password: bool = False,
        connect: bool = False,
    ) -> None:
        """Fill the editor for an SSH connection and save (or Save & Connect).

        ``connect=True`` clicks **Save & Connect**, which saves then immediately
        opens the session — raising the password prompt for password auth — so a
        test never needs a sidebar double-click. ``auth_method`` selects the
        native ``field-authMethod`` dropdown; pass ``key_path`` for key auth.
        ``save_password=True`` toggles the "Save credentials" switch — required to
        raise the key-passphrase prompt on the sidebar-connect path. That field is
        only present when the credential store is not in ``"none"`` mode (see
        :class:`~termihub_harness.ui.CredentialStoreUi`).
        """
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        # The type <select>'s options come from the async-loaded `connectionTypes`
        # store, so they can lag the editor render — retry the select until the
        # "ssh" option exists (self.wait swallows the BridgeError and retries).
        self.wait(
            lambda: self._try_select("connection-editor-type-select", "ssh"),
            what="the connection-type options to load",
        )
        self.wait(
            lambda: self.driver.exists("field-host"), what="the SSH connection fields"
        )
        self.driver.type("field-host", str(host))
        self.driver.type("field-port", str(port))
        self.driver.type("field-username", username)
        if auth_method:
            self.driver.select("field-authMethod", auth_method)
        if key_path is not None:
            # The keyPath field renders a KeyPathInput (with browse + key
            # autocomplete), so its input testid is the KeyPathInput one, not a
            # plain ``field-keyPath``.
            key_input = "field-keyPath-key-path-input"
            self.wait(
                lambda: self.driver.exists(key_input), what="the SSH key-path field"
            )
            self.driver.type(key_input, str(key_path))
        if save_password:
            # The "Save credentials" toggle is a checkbox; a click flips it on so
            # key auth prompts for (and would store) the key passphrase.
            self.wait(
                lambda: self.driver.exists("field-savePassword"),
                what="the Save credentials toggle",
            )
            self.driver.click("field-savePassword")
        self.driver.click(
            "connection-editor-save-connect" if connect else "connection-editor-save"
        )

    # -- connecting --------------------------------------------------------------
    def connect_connection(self, name: str) -> None:
        """Connect a saved connection via a sidebar double-click.

        This is the only connect path that raises the SSH key-passphrase prompt
        (``ConnectionList``'s ``onDoubleClick`` → ``requestPassword``), unlike the
        editor's Save & Connect. Mirrors :meth:`open_connection_menu`'s resilience:
        a save reloads connections from disk a few times and a connection's id can
        change across that reload, so the id is re-resolved by name on every poll
        and the double-click is dispatched only once the current item is mounted.
        """

        def double_clicked() -> bool:
            conn = self.find_connection(name)
            if conn is None:
                return False
            item = connection_item_testid(conn["id"])
            if not self.driver.exists(item):
                return False
            self.driver.double_click(item)
            return True

        self.wait(double_clicked, what=f"the {name!r} connection to connect")

    # -- context menu ------------------------------------------------------------
    def open_connection_menu(self, name: str) -> None:
        """Right-click a connection by name and wait for its menu to mount.

        A save makes the store update *before* the sidebar settles: it reloads
        connections from disk a few times, and a connection's **id can change**
        across that reload. So the connection id is re-resolved by name on every
        poll (never cached) and the right-click is dispatched only once the
        *current* item is in the DOM — otherwise the gesture races a reload that
        replaced or unmounted the element.
        """

        def menu_open() -> bool:
            conn = self.find_connection(name)
            if conn is None:
                return False
            item = connection_item_testid(conn["id"])
            if not self.driver.exists(item):
                return False
            self.driver.context_menu(item)
            return self.driver.exists(self.CTX_EDIT)

        self.wait(menu_open, what=f"the {name!r} connection context menu")

    def connection_context_action(self, name: str, action_test_id: str) -> None:
        """Right-click a connection by name and click a context-menu action."""
        self.open_connection_menu(name)
        self.driver.click(action_test_id)

    def dismiss_menu(self) -> None:
        """Close any open context menu / dialog via Escape."""
        self.driver.press_key("Escape")
