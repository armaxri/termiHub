// Centralized data-testid selectors for E2E tests.
// Keep in sync with React component `data-testid` attributes.

// --- Activity Bar ---
export const ACTIVITY_BAR_CONNECTIONS = '[data-testid="activity-bar-connections"]';
export const ACTIVITY_BAR_FILE_BROWSER = '[data-testid="activity-bar-file-browser"]';
export const ACTIVITY_BAR_SETTINGS = '[data-testid="activity-bar-settings"]';
export const ACTIVITY_BAR_LOGS = '[data-testid="activity-bar-logs"]';
export const SETTINGS_MENU_OPEN = '[data-testid="settings-menu-open"]';
export const SETTINGS_MENU_IMPORT = '[data-testid="settings-menu-import"]';
export const SETTINGS_MENU_EXPORT = '[data-testid="settings-menu-export"]';
export const SETTINGS_MENU_CUSTOMIZE_LAYOUT = '[data-testid="settings-menu-customize-layout"]';

// --- Connection Editor ---
export const CONN_EDITOR_NAME = '[data-testid="connection-editor-name-input"]';
export const CONN_EDITOR_FOLDER = '[data-testid="connection-editor-folder-select"]';
export const CONN_EDITOR_TYPE = '[data-testid="connection-editor-type-select"]';
export const CONN_EDITOR_SAVE = '[data-testid="connection-editor-save"]';
export const CONN_EDITOR_SAVE_CONNECT = '[data-testid="connection-editor-save-connect"]';
export const CONN_EDITOR_CANCEL = '[data-testid="connection-editor-cancel"]';
export const CONN_EDITOR_HORIZONTAL_SCROLL = '[data-testid="connection-editor-horizontal-scroll"]';
export const CONN_EDITOR_COLOR_PICKER = '[data-testid="connection-editor-color-picker"]';
export const CONN_EDITOR_CLEAR_COLOR = '[data-testid="connection-editor-clear-color"]';
export const CONN_EDITOR_ICON_PICKER = '[data-testid="connection-editor-icon-picker"]';
export const CONN_EDITOR_CLEAR_ICON = '[data-testid="connection-editor-clear-icon"]';
export const CONN_EDITOR_SOURCE_FILE = '[data-testid="connection-editor-source-file"]';
export const CONN_SETTINGS_FORM = '[data-testid="connection-settings-form"]';

// --- Local Shell Settings ---
export const SHELL_SELECT = '[data-testid="connection-settings-shell-select"]';
export const STARTING_DIRECTORY = '[data-testid="connection-settings-starting-directory"]';

// --- SSH Settings ---
export const SSH_HOST = '[data-testid="ssh-settings-host-input"]';
export const SSH_PORT = '[data-testid="ssh-settings-port-input"]';
export const SSH_USERNAME = '[data-testid="ssh-settings-username-input"]';
export const SSH_AUTH_METHOD = '[data-testid="ssh-settings-auth-method-select"]';
export const SSH_KEY_PATH = '[data-testid="ssh-settings-key-path-input"]';
export const SSH_X11_CHECKBOX = '[data-testid="ssh-settings-x11-checkbox"]';

// --- Serial Settings ---
export const SERIAL_PORT_SELECT = '[data-testid="serial-settings-port-select"]';
export const SERIAL_PORT_INPUT = '[data-testid="serial-settings-port-input"]';
export const SERIAL_BAUD_RATE = '[data-testid="serial-settings-baud-rate-select"]';
export const SERIAL_DATA_BITS = '[data-testid="serial-settings-data-bits-select"]';
export const SERIAL_STOP_BITS = '[data-testid="serial-settings-stop-bits-select"]';
export const SERIAL_PARITY = '[data-testid="serial-settings-parity-select"]';
export const SERIAL_FLOW_CONTROL = '[data-testid="serial-settings-flow-control-select"]';

// --- Telnet Settings ---
export const TELNET_HOST = '[data-testid="telnet-settings-host-input"]';
export const TELNET_PORT = '[data-testid="telnet-settings-port-input"]';

// --- Connection List ---
export const CONNECTION_LIST_NEW_FOLDER = '[data-testid="connection-list-new-folder"]';
export const CONNECTION_LIST_NEW_CONNECTION = '[data-testid="connection-list-new-connection"]';
export const CONNECTION_LIST_GROUP_TOGGLE = '[data-testid="connection-list-group-toggle"]';
export const INLINE_FOLDER_NAME_INPUT = '[data-testid="inline-folder-name-input"]';
export const INLINE_FOLDER_CONFIRM = '[data-testid="inline-folder-confirm"]';
export const INLINE_FOLDER_CANCEL = '[data-testid="inline-folder-cancel"]';

// Dynamic selectors (functions returning selector strings)
export const connectionItem = (id) => `[data-testid="connection-item-${id}"]`;
export const folderToggle = (id) => `[data-testid="folder-toggle-${id}"]`;

// --- Connection Context Menu ---
export const CTX_CONNECTION_CONNECT = '[data-testid="context-connection-connect"]';
export const CTX_CONNECTION_EDIT = '[data-testid="context-connection-edit"]';
export const CTX_CONNECTION_DUPLICATE = '[data-testid="context-connection-duplicate"]';
export const CTX_CONNECTION_DELETE = '[data-testid="context-connection-delete"]';
export const CTX_CONNECTION_PING = '[data-testid="context-connection-ping"]';

// --- Folder Context Menu ---
export const CTX_FOLDER_NEW_CONNECTION = '[data-testid="context-folder-new-connection"]';
export const CTX_FOLDER_NEW_SUBFOLDER = '[data-testid="context-folder-new-subfolder"]';
export const CTX_FOLDER_DELETE = '[data-testid="context-folder-delete"]';

// --- Tabs (dynamic by UUID) ---
export const tab = (id) => `[data-testid="tab-${id}"]`;
export const tabClose = (id) => `[data-testid="tab-close-${id}"]`;
export const TAB_ACTIVE_CLASS = "tab--active";

// --- Tab Context Menu ---
export const TAB_CTX_SAVE = '[data-testid="tab-context-save"]';
export const TAB_CTX_COPY = '[data-testid="tab-context-copy"]';
export const TAB_CTX_CLEAR = '[data-testid="tab-context-clear"]';
export const TAB_CTX_RENAME = '[data-testid="tab-context-rename"]';
export const TAB_CTX_HORIZONTAL_SCROLL = '[data-testid="tab-context-horizontal-scroll"]';
export const TAB_CTX_SET_COLOR = '[data-testid="tab-context-set-color"]';

// --- Terminal View Toolbar ---
export const TOOLBAR_NEW_TERMINAL = '[data-testid="terminal-view-new-terminal"]';
export const TOOLBAR_SPLIT = '[data-testid="terminal-view-split"]';
export const TOOLBAR_CLOSE_PANEL = '[data-testid="terminal-view-close-panel"]';
export const TOOLBAR_TOGGLE_SIDEBAR = '[data-testid="terminal-view-toggle-sidebar"]';

// --- Color Picker ---
export const COLOR_PICKER_HEX_INPUT = '[data-testid="color-picker-hex-input"]';
export const COLOR_PICKER_CLEAR = '[data-testid="color-picker-clear"]';
export const COLOR_PICKER_APPLY = '[data-testid="color-picker-apply"]';
export const colorPickerSwatch = (hex) =>
  `[data-testid="color-picker-swatch-${hex.replace("#", "")}"]`;

// --- Icon Picker ---
export const ICON_PICKER_SEARCH = '[data-testid="icon-picker-search"]';
export const ICON_PICKER_GRID = '[data-testid="icon-picker-grid"]';
export const ICON_PICKER_CLEAR = '[data-testid="icon-picker-clear"]';
export const ICON_PICKER_APPLY = '[data-testid="icon-picker-apply"]';

// --- File Browser ---
export const FILE_BROWSER_UP = '[data-testid="file-browser-up"]';
export const FILE_BROWSER_REFRESH = '[data-testid="file-browser-refresh"]';
export const FILE_BROWSER_UPLOAD = '[data-testid="file-browser-upload"]';
export const FILE_BROWSER_NEW_FILE = '[data-testid="file-browser-new-file"]';
export const FILE_BROWSER_NEW_FOLDER = '[data-testid="file-browser-new-folder"]';
export const FILE_BROWSER_DISCONNECT = '[data-testid="file-browser-disconnect"]';
export const FILE_BROWSER_NEW_FILE_INPUT = '[data-testid="file-browser-new-file-input"]';
export const FILE_BROWSER_NEW_FILE_CONFIRM = '[data-testid="file-browser-new-file-confirm"]';
export const FILE_BROWSER_NEW_FOLDER_INPUT = '[data-testid="file-browser-new-folder-input"]';
export const FILE_BROWSER_NEW_FOLDER_CONFIRM = '[data-testid="file-browser-new-folder-confirm"]';
export const FILE_BROWSER_CURRENT_PATH = '[data-testid="file-browser-current-path"]';
export const fileRow = (name) => `[data-testid="file-row-${name}"]`;

// --- File Browser Context Menu ---
export const FILE_MENU_OPEN = '[data-testid="file-menu-open"]';
export const FILE_MENU_DOWNLOAD = '[data-testid="file-menu-download"]';
export const FILE_MENU_EDIT = '[data-testid="file-menu-edit"]';
export const FILE_MENU_VSCODE = '[data-testid="file-menu-vscode"]';
export const FILE_MENU_RENAME = '[data-testid="file-menu-rename"]';
export const FILE_MENU_DELETE = '[data-testid="file-menu-delete"]';
export const CTX_FILE_OPEN = '[data-testid="context-file-open"]';
export const CTX_FILE_EDIT = '[data-testid="context-file-edit"]';
export const CTX_FILE_RENAME = '[data-testid="context-file-rename"]';
export const CTX_FILE_DOWNLOAD = '[data-testid="context-file-download"]';
export const CTX_FILE_DELETE = '[data-testid="context-file-delete"]';

// --- Password Prompt ---
export const PASSWORD_PROMPT_INPUT = '[data-testid="password-prompt-input"]';
export const PASSWORD_PROMPT_CANCEL = '[data-testid="password-prompt-cancel"]';
export const PASSWORD_PROMPT_CONNECT = '[data-testid="password-prompt-connect"]';

// --- Status Bar ---
export const STATUS_BAR_TAB_SIZE = '[data-testid="status-bar-tab-size"]';
export const STATUS_BAR_EOL = '[data-testid="status-bar-eol"]';
export const STATUS_BAR_LANGUAGE = '[data-testid="status-bar-language"]';
export const LANG_MENU_SEARCH = '[data-testid="lang-menu-search"]';

// --- Monitoring ---
export const MONITORING_CONNECT_BTN = '[data-testid="monitoring-connect-btn"]';
export const MONITORING_LOADING = '[data-testid="monitoring-loading"]';
export const MONITORING_ERROR = '[data-testid="monitoring-error"]';
export const MONITORING_HOST = '[data-testid="monitoring-host"]';
export const MONITORING_CPU = '[data-testid="monitoring-cpu"]';
export const MONITORING_MEM = '[data-testid="monitoring-mem"]';
export const MONITORING_DISK = '[data-testid="monitoring-disk"]';
export const MONITORING_REFRESH = '[data-testid="monitoring-refresh"]';
export const MONITORING_DISCONNECT = '[data-testid="monitoring-disconnect"]';

// --- Rename Dialog ---
export const RENAME_DIALOG_INPUT = '[data-testid="rename-dialog-input"]';
export const RENAME_DIALOG_CANCEL = '[data-testid="rename-dialog-cancel"]';
export const RENAME_DIALOG_APPLY = '[data-testid="rename-dialog-apply"]';

// --- File Editor ---
export const FILE_EDITOR_SAVE = '[data-testid="file-editor-save"]';

// --- Customize Layout Dialog ---
export const LAYOUT_AB_VISIBLE = '[data-testid="layout-ab-visible"]';
export const LAYOUT_SIDEBAR_VISIBLE = '[data-testid="layout-sidebar-visible"]';
export const LAYOUT_STATUSBAR_VISIBLE = '[data-testid="layout-statusbar-visible"]';
export const LAYOUT_RESET_DEFAULT = '[data-testid="layout-reset-default"]';
export const LAYOUT_CLOSE = '[data-testid="layout-close"]';
export const LAYOUT_PREVIEW = '[data-testid="layout-preview"]';
export const layoutAbPosition = (pos) => `[data-testid="layout-ab-${pos}"]`;
export const layoutSidebarPosition = (pos) => `[data-testid="layout-sidebar-${pos}"]`;
export const layoutPreset = (key) => `[data-testid="layout-preset-${key}"]`;

// --- SSH Tunnel Sidebar ---
export const TUNNEL_SIDEBAR = '[data-testid="tunnel-sidebar"]';
export const TUNNEL_NEW_BTN = '[data-testid="tunnel-new-btn"]';
export const TUNNEL_EMPTY_MESSAGE = '[data-testid="tunnel-empty-message"]';
export const TUNNEL_LIST = '[data-testid="tunnel-list"]';
export const tunnelItem = (id) => `[data-testid="tunnel-item-${id}"]`;
export const tunnelStart = (id) => `[data-testid="tunnel-start-${id}"]`;
export const tunnelStop = (id) => `[data-testid="tunnel-stop-${id}"]`;
export const tunnelEdit = (id) => `[data-testid="tunnel-edit-${id}"]`;
export const tunnelDuplicate = (id) => `[data-testid="tunnel-duplicate-${id}"]`;
export const tunnelDelete = (id) => `[data-testid="tunnel-delete-${id}"]`;

// --- SSH Tunnel Editor ---
export const TUNNEL_EDITOR = '[data-testid="tunnel-editor"]';
export const TUNNEL_EDITOR_TITLE = '[data-testid="tunnel-editor-title"]';
export const TUNNEL_EDITOR_FORM = '[data-testid="tunnel-editor-form"]';
export const TUNNEL_EDITOR_NAME = '[data-testid="tunnel-editor-name"]';
export const TUNNEL_EDITOR_SSH_CONNECTION = '[data-testid="tunnel-editor-ssh-connection"]';
export const TUNNEL_EDITOR_TYPE_SELECTOR = '[data-testid="tunnel-editor-type-selector"]';
export const TUNNEL_TYPE_LOCAL = '[data-testid="tunnel-type-local"]';
export const TUNNEL_TYPE_REMOTE = '[data-testid="tunnel-type-remote"]';
export const TUNNEL_TYPE_DYNAMIC = '[data-testid="tunnel-type-dynamic"]';
export const TUNNEL_DIAGRAM = '[data-testid="tunnel-diagram"]';
export const TUNNEL_EDITOR_SAVE = '[data-testid="tunnel-editor-save"]';
export const TUNNEL_EDITOR_SAVE_START = '[data-testid="tunnel-editor-save-start"]';
export const TUNNEL_EDITOR_CANCEL = '[data-testid="tunnel-editor-cancel"]';

// --- Unlock Dialog (Master Password) ---
export const UNLOCK_DIALOG_INPUT = '[data-testid="unlock-dialog-input"]';
export const UNLOCK_DIALOG_ERROR = '[data-testid="unlock-dialog-error"]';
export const UNLOCK_DIALOG_SKIP = '[data-testid="unlock-dialog-skip"]';
export const UNLOCK_DIALOG_UNLOCK = '[data-testid="unlock-dialog-unlock"]';

// --- Credential Store ---
export const CREDENTIAL_STORE_INDICATOR = '[data-testid="credential-store-indicator"]';

// --- Security Settings ---
export const KEYCHAIN_STATUS = '[data-testid="keychain-status"]';
export const MASTER_PASSWORD_SETUP = '[data-testid="master-password-setup"]';
export const AUTO_LOCK_TIMEOUT = '[data-testid="auto-lock-timeout"]';
export const CHANGE_MASTER_PASSWORD_BTN = '[data-testid="change-master-password-btn"]';

// --- Export/Import Dialogs ---
export const EXPORT_PASSWORD = '[data-testid="export-password"]';
export const EXPORT_CONFIRM_PASSWORD = '[data-testid="export-confirm-password"]';
export const EXPORT_SUBMIT = '[data-testid="export-submit"]';
export const IMPORT_PASSWORD = '[data-testid="import-password"]';
export const IMPORT_WITHOUT_CREDENTIALS = '[data-testid="import-without-credentials"]';
export const IMPORT_WITH_CREDENTIALS = '[data-testid="import-with-credentials"]';
export const IMPORT_SUBMIT = '[data-testid="import-submit"]';

// --- Advanced Settings Toggles ---
export const TOGGLE_POWER_MONITORING = '[data-testid="toggle-power-monitoring"]';
export const TOGGLE_FILE_BROWSER = '[data-testid="toggle-file-browser"]';

// --- Connection Error Dialog ---
export const CONNECTION_ERROR_SETUP_AGENT = '[data-testid="connection-error-setup-agent"]';
export const CONNECTION_ERROR_CLOSE = '[data-testid="connection-error-close"]';

// --- Agent Setup Dialog ---
export const AGENT_SETUP_BINARY_PATH = '[data-testid="agent-setup-binary-path"]';
export const AGENT_SETUP_BROWSE = '[data-testid="agent-setup-browse"]';
export const AGENT_SETUP_REMOTE_PATH = '[data-testid="agent-setup-remote-path"]';
export const AGENT_SETUP_INSTALL_SERVICE = '[data-testid="agent-setup-install-service"]';
export const AGENT_SETUP_CANCEL = '[data-testid="agent-setup-cancel"]';
export const AGENT_SETUP_SUBMIT = '[data-testid="agent-setup-submit"]';

// --- Key Path Input ---
export const keyPathInput = (prefix) => `[data-testid="${prefix}key-path-input"]`;
export const keyPathBrowse = (prefix) => `[data-testid="${prefix}key-path-browse"]`;
export const keyPathDropdown = (prefix) => `[data-testid="${prefix}key-path-dropdown"]`;
export const keyPathOption = (prefix, i) => `[data-testid="${prefix}key-path-option-${i}"]`;

// --- Dynamic Form Fields ---
export const dynamicField = (key) => `[data-testid="dynamic-field-${key}"]`;
export const fieldInput = (key) => `[data-testid="field-${key}"]`;

// --- Tunnel Status ---
export const tunnelStatus = (id) => `[data-testid="tunnel-status-${id}"]`;
export const tunnelName = (id) => `[data-testid="tunnel-name-${id}"]`;
export const tunnelType = (id) => `[data-testid="tunnel-type-${id}"]`;

// --- Agent Context Menu ---
export const CTX_AGENT_CONNECT = '[data-testid="context-agent-connect"]';
export const CTX_AGENT_DISCONNECT = '[data-testid="context-agent-disconnect"]';
export const CTX_AGENT_SETUP = '[data-testid="context-agent-setup"]';
export const CTX_AGENT_NEW_SHELL = '[data-testid="context-agent-new-shell"]';
export const CTX_AGENT_NEW_SERIAL = '[data-testid="context-agent-new-serial"]';
export const CTX_AGENT_REFRESH = '[data-testid="context-agent-refresh"]';
export const CTX_AGENT_EDIT = '[data-testid="context-agent-edit"]';
export const CTX_AGENT_DELETE = '[data-testid="context-agent-delete"]';

// --- Agent Node ---
export const agentNode = (id) => `[data-testid="agent-node-${id}"]`;
export const agentState = (id) => `[data-testid="agent-state-${id}"]`;

// --- Connection Error Dialog ---
export const CONNECTION_ERROR_TITLE = '[data-testid="connection-error-title"]';
export const CONNECTION_ERROR_MESSAGE = '[data-testid="connection-error-message"]';
export const CONNECTION_ERROR_DETAILS = '[data-testid="connection-error-details"]';

// --- File Browser Placeholder ---
export const FILE_BROWSER_PLACEHOLDER = '[data-testid="file-browser-placeholder"]';
export const FILE_BROWSER_SFTP_CONNECTING = '[data-testid="file-browser-sftp-connecting"]';

// --- Per-connection override fields (DynamicForm) ---
export const FIELD_ENABLE_MONITORING = '[data-testid="field-enableMonitoring"]';
export const FIELD_ENABLE_FILE_BROWSER = '[data-testid="field-enableFileBrowser"]';
export const FIELD_SAVE_PASSWORD = '[data-testid="field-savePassword"]';

// --- Generic helpers ---
/** Match all tab elements (for counting) */
export const ALL_TABS =
  '[data-testid^="tab-"]:not([data-testid^="tab-close-"]):not([data-testid^="tab-context-"])';
