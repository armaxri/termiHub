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

from ..bridge import BridgeError
from .base import HarnessMixin
from .lookups import connection_item_testid, find_connection, find_folder


class ConnectionsUi(HarnessMixin):
    """Connection-editor + connection-list interactions for ``SystemTest`` suites."""

    # Stable connection-list / editor testids (UUID-free).
    NEW_FOLDER = "connection-list-new-folder"
    FOLDER_NAME_INPUT = "inline-folder-name-input"
    FOLDER_CONFIRM = "inline-folder-confirm"
    EDITOR_NAME = "connection-editor-name-input"
    EDITOR_TYPE = "connection-editor-type-select"
    EDITOR_SAVE = "connection-editor-save"
    EDITOR_SAVE_CONNECT = "connection-editor-save-connect"
    EDITOR_CANCEL = "connection-editor-cancel"
    EDITOR_NAME_ERROR = "connection-editor-name-error"

    # The SSH key-path field renders a KeyPathInput combobox (browse + key
    # autocomplete), so its input/browse testids carry the KeyPathInput suffix.
    KEY_PATH_INPUT = "field-keyPath-key-path-input"
    KEY_PATH_BROWSE = "field-keyPath-key-path-browse"

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

    def field_visible(self, key: str) -> bool:
        """Whether the ``DynamicForm`` field with schema ``key`` is rendered.

        The editor renders type-specific fields as ``field-<schemaKey>`` from the
        backend schema, so this resolves a schema key to its presence in the DOM.
        """
        return self.driver.exists(f"field-{key}")

    def create_folder(self, name: str) -> dict[str, Any]:
        """Create a connection folder via the sidebar toolbar, returning it."""
        self.driver.click(self.NEW_FOLDER)
        self.wait(
            lambda: self.driver.exists(self.FOLDER_NAME_INPUT),
            what="the folder name input",
        )
        self.driver.type(self.FOLDER_NAME_INPUT, name)
        self.driver.click(self.FOLDER_CONFIRM)
        return self.wait(lambda: self.find_folder(name), what=f"folder {name!r}")

    def open_new_connection_editor(self) -> None:
        """Open a fresh connection editor and wait for its name field.

        Retries the click rather than firing once: right after a terminal
        connects/closes the connection list re-renders (the store reloads and the
        sidebar view can briefly change), so a single click can land while the
        New Connection button is absent. Clicking only while the editor isn't yet
        open keeps this idempotent (it never reopens an already-open editor).
        """

        def opened() -> bool:
            if self.driver.exists("connection-editor-name-input"):
                return True
            # The New Connection button lives only in the connections sidebar
            # view; an earlier file-browser step can leave the sidebar on
            # "files" (seen in the #957 operator run), where the button is
            # absent and the click can never land. Switch back first so this
            # works regardless of the incoming view.
            if not self.driver.exists("connection-list-new-connection"):
                self._ensure_connections_sidebar()
            if self.driver.exists("connection-list-new-connection"):
                self.driver.click("connection-list-new-connection")
            return self.driver.exists("connection-editor-name-input")

        self.wait(opened, what="the connection editor")

    def _ensure_connections_sidebar(self) -> None:
        """Show the connections sidebar view if it is not already active.

        Kept self-contained (rather than depending on ``SidebarUi``) so every
        suite that mixes in :class:`ConnectionsUi` gets the corrective switch.
        Only clicks when the view differs, so it never toggles an already-open
        connections sidebar shut.
        """
        try:
            on_connections = self.driver.get_state("sidebarView") == "connections"
        except BridgeError:
            on_connections = False
        if not on_connections and self.driver.exists("activity-bar-connections"):
            self.driver.click("activity-bar-connections")

    def _try_select(self, test_id: str, value: str) -> bool:
        """``driver.select`` that returns True, for use as a :meth:`wait` predicate.

        A native ``<select>`` whose options load asynchronously raises a
        ``BridgeError`` ("option … not found") until the option exists; wrapping
        the call lets :meth:`wait` retry until it succeeds.
        """
        self.driver.select(test_id, value)
        return True

    def select_connection_type(self, type_id: str) -> None:
        """Choose a connection type in an open editor, waiting for its options.

        The type ``<select>``'s options come from the async-loaded
        ``connectionTypes`` store, so they can lag the editor render — retry the
        select until the requested option exists (``self.wait`` swallows the
        ``BridgeError`` and retries).
        """
        self.wait(
            lambda: self._try_select("connection-editor-type-select", type_id),
            what=f"the {type_id!r} connection-type option to load",
        )

    def _select_when_available(self, test_id: str, value: str, *, what: str) -> None:
        """Select ``value`` in a ``<select>`` whose options load asynchronously.

        Editor dropdown options come from async-loaded backend state (detected
        shells, WSL distros), so the requested option can lag the field's render.
        Retry the select until the option exists (``self.wait`` swallows the
        ``BridgeError`` from a not-yet-present option and retries).
        """
        self.wait(lambda: self._try_select(test_id, value), what=what)

    def _fill_starting_directory(self, value: str) -> None:
        """Fill the editor's optional ``field-startingDirectory`` (awaiting it).

        Shared by the local and WSL editors, whose schemas both expose a
        ``startingDirectory`` field that the backend expands (``/tmp``, ``~/...``,
        ``${env:VAR}``).
        """
        self.wait(
            lambda: self.driver.exists("field-startingDirectory"),
            what="the starting-directory field",
        )
        self.driver.type("field-startingDirectory", value)

    def select_shell(self, shell: str) -> None:
        """Choose a shell in the open Local editor's ``field-shell`` dropdown.

        The shell ``<select>``'s options come from the backend ``settings_schema``
        (the detected shells, e.g. ``powershell``/``cmd``/``gitbash`` on Windows).
        """
        self._select_when_available(
            "field-shell", shell, what=f"the {shell!r} shell option to load"
        )

    def create_local_connection(
        self,
        name: str,
        *,
        shell: Optional[str] = None,
        starting_directory: Optional[str] = None,
        connect: bool = False,
    ) -> str:
        """Create a local-shell connection (the default editor type).

        ``shell`` selects a specific entry in the ``field-shell`` dropdown (e.g.
        ``"powershell"``, ``"cmd"``, ``"gitbash"``); when omitted the platform
        default is kept. ``starting_directory`` fills the optional
        ``field-startingDirectory`` so the shell opens there (supports ``/tmp``,
        ``~/...`` and ``${env:VAR}``, which the backend expands). ``connect=True``
        clicks **Save & Connect**, which saves then immediately opens the terminal
        — so the caller never needs a sidebar double-click.
        """
        self.open_new_connection_editor()
        self.driver.type(self.EDITOR_NAME, name)
        if shell is not None:
            self.select_shell(shell)
        if starting_directory is not None:
            self._fill_starting_directory(starting_directory)
        self._click_editor_save(connect)
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
        self.select_connection_type("ssh")
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
            self.wait(
                lambda: self.driver.exists(self.KEY_PATH_INPUT),
                what="the SSH key-path field",
            )
            self.driver.type(self.KEY_PATH_INPUT, str(key_path))
        if save_password:
            # The "Save credentials" toggle is a checkbox; a click flips it on so
            # key auth prompts for (and would store) the key passphrase.
            self.wait(
                lambda: self.driver.exists("field-savePassword"),
                what="the Save credentials toggle",
            )
            self.driver.click("field-savePassword")
        self._click_editor_save(connect)

    def _click_editor_save(self, connect: bool) -> None:
        """Click Save / Save & Connect once the form reports itself valid.

        Shared by every ``create_*_connection`` helper (SSH/local/telnet/serial/
        FTP/WSL), which all previously fired an immediate click.

        The editor gates both buttons on ``canSave``, which is recomputed
        asynchronously: the schema-driven form validates (react-hook-form + zod)
        and reports validity up through an effect, so it trails the last field we
        type by a render or two. The buttons are ``aria-disabled``/``data-invalid``
        rather than natively ``disabled``, so a bridge click still dispatches — but
        ``handleSaveAndConnect``/``handleSave`` early-return on ``!canSave`` (they
        just focus the first invalid field). A click that lands in that window is
        therefore a silent no-op: the editor stays open and — on the connect path —
        the session (and any password prompt) never opens. Gate on the button
        clearing its ``data-invalid`` flag (``data-invalid={!canSave || undefined}``,
        so absent once valid) before clicking, so the click is never swallowed.
        """
        button = "connection-editor-save-connect" if connect else "connection-editor-save"
        self.wait(
            lambda: self.driver.get_attribute(button, "data-invalid") is None,
            what="the connection form to report itself valid",
        )
        self.driver.click(button)

    def create_telnet_connection(
        self,
        name: str,
        *,
        host: str,
        port: int,
        connect: bool = False,
    ) -> None:
        """Fill the editor for a Telnet connection and save (or Save & Connect).

        Telnet has no auth step in termiHub — login happens inside the session —
        so ``connect=True`` opens a live terminal directly with no password
        prompt. ``field-host`` / ``field-port`` are plain text inputs.
        """
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        self.select_connection_type("telnet")
        self.wait(
            lambda: self.driver.exists("field-host"),
            what="the Telnet connection fields",
        )
        self.driver.type("field-host", str(host))
        self.driver.type("field-port", str(port))
        self._click_editor_save(connect)

    def create_ftp_connection(
        self,
        name: str,
        *,
        host: str = "ftp.example.com",
        port: int = 21,
        tls_mode: str = "none",
        connect: bool = False,
    ) -> None:
        """Fill the editor for an FTP connection and save (or Save & Connect).

        ``tls_mode`` selects the native ``field-tlsMode`` dropdown: ``"none"`` for
        plain FTP (the schema default), ``"explicit"`` / ``"implicit"`` for FTPS.
        Only host/port/tlsMode are required by the backend schema, so
        username/password are left empty — enough to save a connection and drive
        the pre-connect insecure-FTP warning flow (#1338). That warning modal is
        raised on the sidebar connect path (double-click) for plain FTP, so tests
        save here (``connect=False``) and connect via :meth:`connect_connection`.
        """
        self.open_new_connection_editor()
        self.driver.type("connection-editor-name-input", name)
        self.select_connection_type("ftp")
        self.wait(
            lambda: self.driver.exists("field-host"), what="the FTP connection fields"
        )
        self.driver.type("field-host", str(host))
        self.driver.type("field-port", str(port))
        if tls_mode:
            self._select_when_available(
                "field-tlsMode", tls_mode, what=f"the {tls_mode!r} TLS-mode option"
            )
        self._click_editor_save(connect)
        self.require_connection(name)

    def open_serial_editor(self) -> None:
        """Open the editor and switch it to the Serial type, awaiting its fields.

        The serial port field is an **editable combobox** (an ``<input>`` wired to
        a ``<datalist>`` of detected ports), so an arbitrary device path can be
        typed into ``field-port`` — see :meth:`create_serial_connection`.
        """
        self.open_new_connection_editor()
        self.select_connection_type("serial")
        self.wait(
            lambda: self.driver.exists("field-port"),
            what="the Serial connection fields",
        )

    def create_serial_connection(
        self,
        name: str,
        *,
        port: str,
        connect: bool = False,
    ) -> None:
        """Fill the editor for a Serial connection and save (or Save & Connect).

        ``port`` is typed directly into the ``field-port`` combobox, so a path the
        OS does not enumerate (a virtual/socat PTY) works — the field is no longer
        a detection-only ``<select>`` (#854).
        """
        self.open_serial_editor()
        self.driver.type("connection-editor-name-input", name)
        self.driver.type("field-port", port)
        self._click_editor_save(connect)

    def open_wsl_editor(self) -> None:
        """Open the editor and switch it to the WSL type, awaiting its fields.

        WSL is a **dedicated Windows-only connection type** (not an entry in the
        Local shell dropdown), registered only when the backend is built for
        Windows — so this only succeeds on a Windows host. The distribution field
        (``field-distribution``) is a ``<select>`` whose options come from
        ``wsl.exe --list``; see :meth:`create_wsl_connection`.
        """
        self.open_new_connection_editor()
        self.select_connection_type("wsl")
        self.wait(
            lambda: self.driver.exists("field-distribution"),
            what="the WSL connection fields",
        )

    def create_wsl_connection(
        self,
        name: str,
        *,
        distribution: str,
        starting_directory: Optional[str] = None,
        connect: bool = False,
    ) -> str:
        """Fill the editor for a WSL connection and save (or Save & Connect).

        ``distribution`` selects the ``field-distribution`` option (a distro name
        from ``wsl.exe --list``, e.g. ``"Ubuntu"``). WSL has no auth step, so
        ``connect=True`` opens a live terminal directly with no password prompt.
        ``starting_directory`` fills the optional ``field-startingDirectory``.
        """
        self.open_wsl_editor()
        self.driver.type(self.EDITOR_NAME, name)
        self._select_when_available(
            "field-distribution",
            distribution,
            what=f"the {distribution!r} WSL distribution option to load",
        )
        if starting_directory is not None:
            self._fill_starting_directory(starting_directory)
        self._click_editor_save(connect)
        self.require_connection(name)
        return name

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

        Delegates to :meth:`HarnessMixin.open_named_context_menu`: the connection
        id is re-resolved by name on every poll (a save reloads connections from
        disk a few times and an id can change across that reload), and the
        right-click is dispatched only once the *current* item is in the DOM —
        otherwise the gesture races a reload that replaced or unmounted it.
        """
        self.open_named_context_menu(
            resolve=lambda: self.find_connection(name),
            testid_for=connection_item_testid,
            sentinel=self.CTX_EDIT,
            what=f"the {name!r} connection context menu",
        )

    def connection_context_action(self, name: str, action_test_id: str) -> None:
        """Right-click a connection by name and click a context-menu action."""
        self.open_connection_menu(name)
        self.driver.click(action_test_id)

    def dismiss_menu(self) -> None:
        """Close any open context menu / dialog via Escape."""
        self.driver.press_key("Escape")
