import { ConnectionConfig, RemoteAgentConfig, TerminalOptions } from "./terminal";
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

/** Capabilities reported by a connected remote agent. */
export interface AgentCapabilities {
  connectionTypes: ConnectionTypeInfo[];
  maxSessions: number;
  availableShells?: string[];
  availableSerialPorts?: string[];
  dockerAvailable?: boolean;
  availableDockerImages?: string[];
}

/** A remote agent definition stored in the sidebar as a folder-like entry. */
export interface RemoteAgentDefinition {
  id: string;
  name: string;
  config: RemoteAgentConfig;
  isExpanded: boolean;
  connectionState: "disconnected" | "connecting" | "connected" | "reconnecting";
  capabilities?: AgentCapabilities;
}

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

export interface AppSettings {
  version: string;
  externalConnectionFiles: ExternalFileConfig[];
  defaultUser?: string;
  defaultSshKeyPath?: string;
  defaultShell?: string;
  theme?: "dark" | "light" | "system";
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  defaultHorizontalScrolling?: boolean;
  scrollbackBuffer?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  powerMonitoringEnabled: boolean;
  fileBrowserEnabled: boolean;
  layout?: LayoutConfig;
  credentialStorageMode?: "master_password" | "none";
  credentialAutoLockMinutes?: number;
  rightClickBehavior?: "contextMenu" | "quickAction";
  keybindingOverrides?: KeybindingOverrideEntry[];
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
