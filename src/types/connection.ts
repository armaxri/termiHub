import { ConnectionConfig, TerminalOptions } from "./terminal";

export interface SavedConnection {
  id: string;
  name: string;
  config: ConnectionConfig;
  folderId: string | null;
  terminalOptions?: TerminalOptions;
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
