/**
 * Tauri command wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import { SessionId, ConnectionConfig } from "@/types/terminal";
import { SavedConnection, ConnectionFolder } from "@/types/connection";

// --- Terminal commands ---

/** Create a new terminal session */
export async function createTerminal(config: ConnectionConfig): Promise<SessionId> {
  return await invoke<string>("create_terminal", { config });
}

/** Send input data to a terminal session */
export async function sendInput(sessionId: SessionId, data: string): Promise<void> {
  await invoke("send_input", { sessionId, data });
}

/** Resize a terminal session */
export async function resizeTerminal(sessionId: SessionId, cols: number, rows: number): Promise<void> {
  await invoke("resize_terminal", { sessionId, cols, rows });
}

/** Close a terminal session */
export async function closeTerminal(sessionId: SessionId): Promise<void> {
  await invoke("close_terminal", { sessionId });
}

/** List available serial ports */
export async function listSerialPorts(): Promise<string[]> {
  return await invoke<string[]>("list_serial_ports");
}

/** List available shells on this platform */
export async function listAvailableShells(): Promise<string[]> {
  return await invoke<string[]>("list_available_shells");
}

// --- Connection persistence commands ---

interface ConnectionData {
  connections: SavedConnection[];
  folders: ConnectionFolder[];
}

/** Load all saved connections and folders from disk */
export async function loadConnectionsAndFolders(): Promise<ConnectionData> {
  return await invoke<ConnectionData>("load_connections_and_folders");
}

/** Save (add or update) a connection */
export async function saveConnection(connection: SavedConnection): Promise<void> {
  await invoke("save_connection", { connection });
}

/** Delete a connection by ID */
export async function deleteConnectionFromBackend(id: string): Promise<void> {
  await invoke("delete_connection", { id });
}

/** Save (add or update) a folder */
export async function saveFolder(folder: ConnectionFolder): Promise<void> {
  await invoke("save_folder", { folder });
}

/** Delete a folder by ID */
export async function deleteFolderFromBackend(id: string): Promise<void> {
  await invoke("delete_folder", { id });
}

/** Export all connections as a JSON string */
export async function exportConnections(): Promise<string> {
  return await invoke<string>("export_connections");
}

/** Import connections from a JSON string. Returns count imported. */
export async function importConnections(json: string): Promise<number> {
  return await invoke<number>("import_connections", { json });
}
