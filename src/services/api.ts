/**
 * Tauri command wrappers.
 * Phase 1: Stubs returning mock data. Phase 2 will call invoke().
 */

import { SessionId, ConnectionConfig } from "@/types/terminal";

/** Create a new terminal session */
export async function createTerminal(_config: ConnectionConfig): Promise<SessionId> {
  // Phase 2: return await invoke("create_terminal", { config });
  return `mock-session-${Date.now()}`;
}

/** Send input data to a terminal session */
export async function sendInput(_sessionId: SessionId, _data: string): Promise<void> {
  // Phase 2: await invoke("send_input", { sessionId, data });
}

/** Resize a terminal session */
export async function resizeTerminal(_sessionId: SessionId, _cols: number, _rows: number): Promise<void> {
  // Phase 2: await invoke("resize_terminal", { sessionId, cols, rows });
}

/** Close a terminal session */
export async function closeTerminal(_sessionId: SessionId): Promise<void> {
  // Phase 2: await invoke("close_terminal", { sessionId });
}

/** List available serial ports */
export async function listSerialPorts(): Promise<string[]> {
  // Phase 2: return await invoke("list_serial_ports");
  return ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyACM0"];
}

/** List available shells on this platform */
export async function listAvailableShells(): Promise<string[]> {
  // Phase 2: return await invoke("list_available_shells");
  return ["bash", "zsh"];
}
