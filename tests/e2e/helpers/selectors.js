// Centralized data-testid selectors for E2E tests.
// Keep in sync with React component `data-testid` attributes.

// --- Activity Bar ---
export const ACTIVITY_BAR_CONNECTIONS = '[data-testid="activity-bar-connections"]';
export const ACTIVITY_BAR_FILE_BROWSER = '[data-testid="activity-bar-file-browser"]';
export const ACTIVITY_BAR_SETTINGS = '[data-testid="activity-bar-settings"]';
export const SETTINGS_MENU_OPEN = '[data-testid="settings-menu-open"]';
export const SETTINGS_MENU_IMPORT = '[data-testid="settings-menu-import"]';
export const SETTINGS_MENU_EXPORT = '[data-testid="settings-menu-export"]';

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
export const TAB_ACTIVE_CLASS = 'tab--active';

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

// --- Color Picker ---
export const COLOR_PICKER_HEX_INPUT = '[data-testid="color-picker-hex-input"]';
export const COLOR_PICKER_CLEAR = '[data-testid="color-picker-clear"]';
export const COLOR_PICKER_APPLY = '[data-testid="color-picker-apply"]';
export const colorPickerSwatch = (hex) => `[data-testid="color-picker-swatch-${hex.replace('#', '')}"]`;

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
export const fileRow = (name) => `[data-testid="file-row-${name}"]`;

// --- Password Prompt ---
export const PASSWORD_PROMPT_INPUT = '[data-testid="password-prompt-input"]';
export const PASSWORD_PROMPT_CANCEL = '[data-testid="password-prompt-cancel"]';
export const PASSWORD_PROMPT_CONNECT = '[data-testid="password-prompt-connect"]';

// --- Status Bar ---
export const STATUS_BAR_TAB_SIZE = '[data-testid="status-bar-tab-size"]';
export const STATUS_BAR_EOL = '[data-testid="status-bar-eol"]';

// --- Monitoring ---
export const MONITORING_CONNECT_BTN = '[data-testid="monitoring-connect-btn"]';
export const MONITORING_LOADING = '[data-testid="monitoring-loading"]';
export const MONITORING_ERROR = '[data-testid="monitoring-error"]';
export const MONITORING_HOST = '[data-testid="monitoring-host"]';
export const MONITORING_CPU = '[data-testid="monitoring-cpu"]';
export const MONITORING_MEM = '[data-testid="monitoring-mem"]';
export const MONITORING_DISK = '[data-testid="monitoring-disk"]';

// --- Rename Dialog ---
export const RENAME_DIALOG_INPUT = '[data-testid="rename-dialog-input"]';
export const RENAME_DIALOG_CANCEL = '[data-testid="rename-dialog-cancel"]';
export const RENAME_DIALOG_APPLY = '[data-testid="rename-dialog-apply"]';

// --- File Editor ---
export const FILE_EDITOR_SAVE = '[data-testid="file-editor-save"]';

// --- Generic helpers ---
/** Match all tab elements (for counting) */
export const ALL_TABS = '[data-testid^="tab-"]:not([data-testid^="tab-close-"]):not([data-testid^="tab-context-"])';
