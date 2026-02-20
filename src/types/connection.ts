import { ConnectionConfig, RemoteAgentConfig, TerminalOptions } from "./terminal";

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

/** Capabilities reported by a connected remote agent. */
export interface AgentCapabilities {
  sessionTypes: string[];
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

export interface AppSettings {
  version: string;
  externalConnectionFiles: ExternalFileConfig[];
  powerMonitoringEnabled: boolean;
  fileBrowserEnabled: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  permissions: string | null;
}
