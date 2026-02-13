/**
 * Tauri command wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import { SessionId, ConnectionConfig, SshConfig } from "@/types/terminal";
import { SavedConnection, ConnectionFolder, FileEntry, ExternalConnectionSource, AppSettings } from "@/types/connection";

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
  externalSources: ExternalConnectionSource[];
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

// --- Settings commands ---

/** Get the current application settings */
export async function getSettings(): Promise<AppSettings> {
  return await invoke<AppSettings>("get_settings");
}

/** Update and persist application settings */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

/** Save an external connection file to disk */
export async function saveExternalFile(
  filePath: string,
  name: string,
  folders: ConnectionFolder[],
  connections: SavedConnection[],
): Promise<void> {
  await invoke("save_external_file", { filePath, name, folders, connections });
}

/** Reload external connection files */
export async function reloadExternalConnections(): Promise<ExternalConnectionSource[]> {
  return await invoke<ExternalConnectionSource[]>("reload_external_connections");
}

// --- SFTP commands ---

/** Open a new SFTP session. Returns session ID. */
export async function sftpOpen(config: SshConfig): Promise<string> {
  return await invoke<string>("sftp_open", { config });
}

/** Close an SFTP session. */
export async function sftpClose(sessionId: string): Promise<void> {
  await invoke("sftp_close", { sessionId });
}

/** List directory contents via SFTP. */
export async function sftpListDir(sessionId: string, path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("sftp_list_dir", { sessionId, path });
}

/** Download a remote file to a local path. Returns bytes transferred. */
export async function sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<number> {
  return await invoke<number>("sftp_download", { sessionId, remotePath, localPath });
}

/** Upload a local file to a remote path. Returns bytes transferred. */
export async function sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<number> {
  return await invoke<number>("sftp_upload", { sessionId, localPath, remotePath });
}

/** Create a directory on the remote host. */
export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  await invoke("sftp_mkdir", { sessionId, path });
}

/** Delete a file or directory on the remote host. */
export async function sftpDelete(sessionId: string, path: string, isDirectory: boolean): Promise<void> {
  await invoke("sftp_delete", { sessionId, path, isDirectory });
}

/** Rename a file or directory on the remote host. */
export async function sftpRename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
  await invoke("sftp_rename", { sessionId, oldPath, newPath });
}

// --- Local filesystem commands ---

/** List directory contents on the local filesystem. */
export async function localListDir(path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("local_list_dir", { path });
}

/** Create a directory on the local filesystem. */
export async function localMkdir(path: string): Promise<void> {
  await invoke("local_mkdir", { path });
}

/** Delete a file or directory on the local filesystem. */
export async function localDelete(path: string, isDirectory: boolean): Promise<void> {
  await invoke("local_delete", { path, isDirectory });
}

/** Rename a file or directory on the local filesystem. */
export async function localRename(oldPath: string, newPath: string): Promise<void> {
  await invoke("local_rename", { oldPath, newPath });
}

// --- VS Code integration ---

/** Check if VS Code CLI (`code`) is available on PATH. */
export async function vscodeAvailable(): Promise<boolean> {
  return await invoke<boolean>("vscode_available");
}

/** Open a local file in VS Code (fire-and-forget). */
export async function vscodeOpenLocal(path: string): Promise<void> {
  await invoke("vscode_open_local", { path });
}

/** Open a remote file in VS Code: download, edit, re-upload. */
export async function vscodeOpenRemote(sessionId: string, remotePath: string): Promise<void> {
  await invoke("vscode_open_remote", { sessionId, remotePath });
}
