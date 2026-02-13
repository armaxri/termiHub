/**
 * Connection persistence via Tauri backend.
 */

import { SavedConnection, ConnectionFolder, ExternalConnectionSource } from "@/types/connection";
import {
  loadConnectionsAndFolders,
  saveConnection,
  deleteConnectionFromBackend,
  saveFolder,
  deleteFolderFromBackend,
  exportConnections,
  importConnections,
  getSettings,
  saveSettings,
  saveExternalFile,
  reloadExternalConnections,
} from "./api";

/** Load all saved connections, folders, and external sources from the backend */
export async function loadConnections(): Promise<{
  connections: SavedConnection[];
  folders: ConnectionFolder[];
  externalSources: ExternalConnectionSource[];
}> {
  return await loadConnectionsAndFolders();
}

/** Persist a connection (add or update) */
export async function persistConnection(connection: SavedConnection): Promise<void> {
  await saveConnection(connection);
}

/** Delete a connection from persistent storage */
export async function removeConnection(id: string): Promise<void> {
  await deleteConnectionFromBackend(id);
}

/** Persist a folder (add or update) */
export async function persistFolder(folder: ConnectionFolder): Promise<void> {
  await saveFolder(folder);
}

/** Delete a folder from persistent storage */
export async function removeFolder(id: string): Promise<void> {
  await deleteFolderFromBackend(id);
}

/** Export all connections as JSON */
export { exportConnections };

/** Import connections from JSON */
export { importConnections };

/** Get application settings */
export { getSettings };

/** Save application settings */
export { saveSettings };

/** Save an external connection file to disk */
export { saveExternalFile };

/** Reload external connection files */
export { reloadExternalConnections };
