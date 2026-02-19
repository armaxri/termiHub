import { ConnectionConfig, RemoteAgentConfig, TerminalOptions } from "./terminal";

export interface SavedConnection {
  id: string;
  name: string;
  config: ConnectionConfig;
  folderId: string | null;
  terminalOptions?: TerminalOptions;
  icon?: string;
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

export interface ExternalConnectionSource {
  filePath: string;
  name: string;
  folders: ConnectionFolder[];
  connections: SavedConnection[];
  error: string | null;
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
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  permissions: string | null;
}
