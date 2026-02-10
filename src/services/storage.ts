/**
 * Local storage helpers for connection persistence.
 * Phase 1: Stub. Phase 4 will use Tauri's fs/path APIs.
 */

import { SavedConnection, ConnectionFolder } from "@/types/connection";

const CONNECTIONS_KEY = "termihub_connections";
const FOLDERS_KEY = "termihub_folders";

/** Load saved connections from local storage */
export function loadConnections(): SavedConnection[] {
  try {
    const data = localStorage.getItem(CONNECTIONS_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/** Save connections to local storage */
export function saveConnections(connections: SavedConnection[]): void {
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
}

/** Load saved folders from local storage */
export function loadFolders(): ConnectionFolder[] {
  try {
    const data = localStorage.getItem(FOLDERS_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/** Save folders to local storage */
export function saveFolders(folders: ConnectionFolder[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
}
