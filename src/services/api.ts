/**
 * Tauri command wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import { SessionId, ConnectionConfig } from "@/types/terminal";

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
