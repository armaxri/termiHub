/**
 * Tauri event listener setup.
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";

interface TerminalOutputPayload {
  session_id: string;
  data: number[];
}

interface TerminalExitPayload {
  session_id: string;
  exit_code: number | null;
}

/** Subscribe to terminal output events */
export async function onTerminalOutput(
  callback: (sessionId: string, data: Uint8Array) => void
): Promise<UnlistenFn> {
  return await listen<TerminalOutputPayload>("terminal-output", (event) => {
    const { session_id, data } = event.payload;
    callback(session_id, new Uint8Array(data));
  });
}

/** Subscribe to terminal exit events */
export async function onTerminalExit(
  callback: (sessionId: string, exitCode: number | null) => void
): Promise<UnlistenFn> {
  return await listen<TerminalExitPayload>("terminal-exit", (event) => {
    const { session_id, exit_code } = event.payload;
    callback(session_id, exit_code);
  });
}

interface VscodeEditCompletePayload {
  remotePath: string;
  success: boolean;
  error: string | null;
}

/** Subscribe to VS Code edit-complete events (remote file re-upload). */
export async function onVscodeEditComplete(
  callback: (remotePath: string, success: boolean, error: string | null) => void
): Promise<UnlistenFn> {
  return await listen<VscodeEditCompletePayload>("vscode-edit-complete", (event) => {
    callback(event.payload.remotePath, event.payload.success, event.payload.error);
  });
}
