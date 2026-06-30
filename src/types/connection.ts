import { ConnectionConfig, RemoteAgentConfig, TerminalOptions, LineEnding } from "./terminal";
import { SettingsSchema, Capabilities } from "./schema";
import { KeybindingOverrideEntry } from "./keybindings";

export interface SavedConnection {
  id: string;
  name: string;
  config: ConnectionConfig;
  folderId: string | null;
  terminalOptions?: TerminalOptions;
  icon?: string;
  /** Which external file this connection was loaded from. null = main connections.json. */
  sourceFile?: string | null;
}

export interface ConnectionFolder {
  id: string;
  name: string;
  parentId: string | null;
  isExpanded: boolean;
}

/**
 * A single jump host (bastion) hop in an SSH `ProxyJump` chain.
 *
 * Mirrors the Rust `JumpHostConfig` (`core/src/config/mod.rs`). Stored inline on
 * an SSH connection's `proxyJump` array. `connectionId` (a reference to a saved
 * SSH connection) is reserved for a later phase; current editing uses the inline
 * connection fields.
 */
export interface JumpHostConfig {
  /** Reference to a saved SSH connection (reserved; resolved by a later phase). */
  connectionId?: string;
  host: string;
  port: number;
  username: string;
  /** "key" | "password" | "agent". */
  authMethod: string;
  password?: string;
  keyPath?: string;
  /**
   * Per-hop connect/handshake timeout (seconds). Unset falls back to the default
   * SSH connect timeout, mirroring the target's `connectTimeoutSecs` (#951).
   */
  connectTimeoutSecs?: number;
}

export type ConnectionTreeItem =
  | { type: "folder"; folder: ConnectionFolder }
  | { type: "connection"; connection: SavedConnection };

export interface ExternalFileConfig {
  path: string;
  enabled: boolean;
}

/** Error encountered when loading an external connection file. */
export interface ExternalFileError {
  filePath: string;
  error: string;
}

/** A warning generated during file recovery at startup. */
export interface RecoveryWarning {
  fileName: string;
  message: string;
  details: string | null;
}

/** Info about a connection type from the backend registry. */
export interface ConnectionTypeInfo {
  typeId: string;
  displayName: string;
  icon: string;
  schema: SettingsSchema;
  capabilities: Capabilities;
}

/** Runtime behaviour preferences for a connected remote agent. */
export interface AgentSettings {
  enableMonitoring: boolean;
  enableFileBrowser: boolean;
  enableDocker: boolean;
  defaultShell: string | null;
  startingDirectory: string;
  logLevel: "error" | "warn" | "info" | "debug" | "trace";
  verboseTracing: boolean;
  /** Ring-buffer size for persistent sessions in MiB (1–64). */
  persistentScrollbackBufferSizeMb: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enableMonitoring: true,
  enableFileBrowser: true,
  enableDocker: true,
  defaultShell: null,
  startingDirectory: "~",
  logLevel: "info",
  verboseTracing: false,
  persistentScrollbackBufferSizeMb: 1,
};

/** Capabilities reported by a connected remote agent. */
export interface AgentCapabilities {
  connectionTypes: ConnectionTypeInfo[];
  maxSessions: number;
  availableShells?: string[];
  availableSerialPorts?: string[];
  dockerAvailable?: boolean;
  availableDockerImages?: string[];
  /** Whether `/proc`-based (or platform-equivalent) monitoring is available. */
  monitoringSupported?: boolean;
  /** Agent binary version string, e.g. "1.4.2". */
  agentVersion?: string;
}

/** A remote agent definition stored in the sidebar as a folder-like entry. */
export interface RemoteAgentDefinition {
  id: string;
  name: string;
  config: RemoteAgentConfig;
  agentSettings: AgentSettings;
  isExpanded: boolean;
  connectionState: "disconnected" | "connecting" | "connected" | "reconnecting";
  capabilities?: AgentCapabilities;
}

// ── Persistent connection session state ──────────────────────────────────

/** Live run-state of a persistent connection's background process. */
export type PersistentRunState =
  | "stopped"
  | "starting"
  | "running"
  | "attached"
  | "stopping"
  | "error";

/** Frontend state entry for one persistent connection. */
export interface PersistentSessionEntry {
  connectionId: string;
  sessionId: string | null;
  state: PersistentRunState;
  /** IDs of tabs currently attached to this session. */
  attachedTabIds: string[];
  errorMessage?: string;
}

// ── Layout / activity bar ─────────────────────────────────────────────────

export type ActivityBarPosition = "left" | "right" | "top" | "hidden";
export type SidebarPosition = "left" | "right";

export interface LayoutConfig {
  activityBarPosition: ActivityBarPosition;
  sidebarPosition: SidebarPosition;
  sidebarVisible: boolean;
  statusBarVisible: boolean;
  hiddenActivityBarViews: string[];
  /** The currently active sidebar panel. Persisted across restarts. */
  sidebarView?: string;
  /** Whether the sidebar is currently collapsed. Persisted across restarts. */
  sidebarCollapsed?: boolean;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  activityBarPosition: "left",
  sidebarPosition: "left",
  sidebarVisible: true,
  statusBarVisible: true,
  hiddenActivityBarViews: [],
};

export const LAYOUT_PRESETS: Record<string, LayoutConfig> = {
  default: {
    activityBarPosition: "left",
    sidebarPosition: "left",
    sidebarVisible: true,
    statusBarVisible: true,
    hiddenActivityBarViews: [],
  },
  focus: {
    activityBarPosition: "left",
    sidebarPosition: "left",
    sidebarVisible: false,
    statusBarVisible: true,
    hiddenActivityBarViews: [],
  },
  zen: {
    activityBarPosition: "hidden",
    sidebarPosition: "left",
    sidebarVisible: false,
    statusBarVisible: false,
    hiddenActivityBarViews: [],
  },
};

/** A Linux `/dev` prefix entry for the serial port scanner. */
export interface SerialPortScanPrefix {
  prefix: string;
  enabled: boolean;
  /** `true` = shipped with termiHub; `false` = user-added. */
  builtIn: boolean;
}

export interface AppSettings {
  version: string;
  externalConnectionFiles: ExternalFileConfig[];
  defaultUser?: string;
  defaultSshKeyPath?: string;
  defaultShell?: string;
  theme?: "dark" | "light" | "solarized-dark" | "solarized-light" | "system";
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  defaultHorizontalScrolling?: boolean;
  scrollbackBuffer?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  powerMonitoringEnabled: boolean;
  fileBrowserEnabled: boolean;
  /**
   * Show a confirmation dialog when the user closes a tab via the
   * close-tab or close-tab-group keyboard shortcut. Defaults to true.
   * The X-button on tabs always closes immediately and is unaffected by this setting.
   */
  confirmCloseTabOnShortcut?: boolean;
  /**
   * When true (default), saving terminal content to a file shows a dialog
   * offering to open the saved file in a Monaco editor tab. When false, the
   * file is saved silently and no dialog or editor tab is opened.
   */
  askOpenSavedFileInTab?: boolean;
  defaultShellIntegration?: boolean;
  defaultX11Forwarding?: boolean;
  /**
   * When true (default), the open tab groups and layout are auto-saved on every
   * change and restored on the next startup. When false, the app always starts
   * with a fresh empty session.
   */
  restoreLastSessionOnStartup?: boolean;
  layout?: LayoutConfig;
  credentialStorageMode?: "master_password" | "os_keychain" | "none";
  credentialAutoLockMinutes?: number;
  rightClickBehavior?: "contextMenu" | "quickAction";
  /**
   * Default line ending sent on Enter and used to normalize pasted text for
   * new terminals. Per-connection `terminalOptions.lineEnding` overrides this.
   * Defaults to `lf` when unset.
   */
  defaultLineEnding?: LineEnding;
  keybindingOverrides?: KeybindingOverrideEntry[];
  /**
   * When true (default), application shortcuts that collide with standard
   * shell, tmux, vim, or SSH-to-remote keys are suppressed while the terminal
   * pane is focused so the keystroke reaches the PTY. Toggle off to make
   * every shortcut fire regardless of focus.
   */
  terminalKeyPassthrough?: boolean;
  /**
   * When true (default), an active editor or input-bearing tab handles its own
   * editing shortcuts (Find, Replace, Select All, …) — the global keyboard
   * dispatcher steps aside so the focused widget receives the key. Toggle off to
   * restore the old global-first behavior where app shortcuts fire regardless of
   * the active tab's content.
   */
  editorShortcutDelegation?: boolean;
  /**
   * User-defined file-type overrides for the built-in language mapping.
   * Keys are exact filenames (e.g. `"Jenkinsfile"`) or extensions (e.g. `".conf"`).
   * Values are Monaco language IDs (e.g. `"groovy"`, `"ini"`).
   * These take precedence over the built-in defaults.
   */
  fileLanguageMappings?: Record<string, string>;
  /**
   * Additional Shiki language package IDs to load for syntax highlighting.
   * Values are Shiki bundled language IDs (e.g. `"astro"`, `"svelte"`, `"zig"`).
   * The built-in packages (cmake, toml, nginx, nix) are always loaded regardless.
   */
  installedLanguagePackages?: string[];
  /**
   * User-imported custom TextMate grammar definitions for languages not in Shiki's
   * bundled set. Each entry stores the full grammar JSON so it works without the
   * original file being present.
   */
  customLanguageGrammars?: CustomLanguageGrammar[];
  experimentalFeaturesEnabled?: boolean;
  updates?: UpdateSettings;
  /** Linux `/dev` prefixes used when scanning for serial ports. Always present after `get_settings` (expanded from built-in defaults if never saved). */
  serialPortScanPrefixes?: SerialPortScanPrefix[];
}

/**
 * A user-imported TextMate grammar definition.
 * The `grammar` field is the parsed `.tmLanguage.json` content stored verbatim.
 */
export interface CustomLanguageGrammar {
  /** Monaco / Shiki language ID used in file-type mappings (e.g. `"my-lang"`). */
  id: string;
  /** Human-readable display name shown in the language picker. */
  name: string;
  /** The raw TextMate grammar object (contents of the `.tmLanguage.json` file). */
  grammar: Record<string, unknown>;
}

/** Persisted update-checker configuration returned from the backend. */
export interface UpdateSettings {
  autoCheck: boolean;
  lastCheckTime?: string;
  skippedVersion?: string;
}

/** Result of an update check returned from the backend. */
export interface UpdateInfo {
  available: boolean;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  isSecurity: boolean;
}

/** Current app mode returned by the backend. */
export interface AppModeInfo {
  isPortable: boolean;
  /** Absolute path to the portable data directory, or null in installed mode. */
  dataDir: string | null;
}

/** Status of a single config file in a directory. */
export interface ConfigFileStatus {
  name: string;
  present: boolean;
}

/** Result of a config export or import operation. */
export interface ConfigMigrationResult {
  filesCopied: string[];
  warnings: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  permissions: string | null;
}
