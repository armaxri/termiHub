import { ConnectionConfig, RemoteAgentConfig, TerminalOptions } from "./terminal";
import { SettingsSchema, Capabilities } from "./schema";

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
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  activityBarPosition: "left",
  sidebarPosition: "left",
  sidebarVisible: true,
  statusBarVisible: true,
};

export const LAYOUT_PRESETS: Record<string, LayoutConfig> = {
  default: {
    activityBarPosition: "left",
    sidebarPosition: "left",
    sidebarVisible: true,
    statusBarVisible: true,
  },
  focus: {
    activityBarPosition: "left",
    sidebarPosition: "left",
    sidebarVisible: false,
    statusBarVisible: true,
  },
  zen: {
    activityBarPosition: "hidden",
    sidebarPosition: "left",
    sidebarVisible: false,
    statusBarVisible: false,
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
  defaultHorizontalScrolling?: boolean;
  scrollbackBuffer?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  powerMonitoringEnabled: boolean;
  fileBrowserEnabled: boolean;
  layout?: LayoutConfig;
  credentialStorageMode?: "keychain" | "master_password" | "none";
  credentialAutoLockMinutes?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  permissions: string | null;
}
