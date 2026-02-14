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

/**
 * Singleton dispatcher that registers one global Tauri listener for each
 * terminal event type and routes events to per-session callbacks via Map
 * lookup. This replaces the O(N) fan-out pattern where each Terminal
 * component registered its own global listener.
 */
export class TerminalOutputDispatcher {
  private outputCallbacks = new Map<string, (data: Uint8Array) => void>();
  private exitCallbacks = new Map<string, (exitCode: number | null) => void>();
  private unlistenOutput: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  private initialized = false;

  /** Register global Tauri event listeners. Call once when TerminalView mounts. */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.unlistenOutput = await listen<TerminalOutputPayload>("terminal-output", (event) => {
      const { session_id, data } = event.payload;
      const cb = this.outputCallbacks.get(session_id);
      if (cb) {
        cb(new Uint8Array(data));
      }
    });

    this.unlistenExit = await listen<TerminalExitPayload>("terminal-exit", (event) => {
      const { session_id, exit_code } = event.payload;
      const cb = this.exitCallbacks.get(session_id);
      if (cb) {
        cb(exit_code);
      }
    });
  }

  /** Subscribe to output events for a specific session. Returns an unsubscribe function. */
  subscribeOutput(sessionId: string, callback: (data: Uint8Array) => void): () => void {
    this.outputCallbacks.set(sessionId, callback);
    return () => {
      this.outputCallbacks.delete(sessionId);
    };
  }

  /** Subscribe to exit events for a specific session. Returns an unsubscribe function. */
  subscribeExit(sessionId: string, callback: (exitCode: number | null) => void): () => void {
    this.exitCallbacks.set(sessionId, callback);
    return () => {
      this.exitCallbacks.delete(sessionId);
    };
  }

  /** Tear down global listeners and clear all callbacks. Call when TerminalView unmounts. */
  destroy(): void {
    if (this.unlistenOutput) {
      this.unlistenOutput();
      this.unlistenOutput = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
    this.outputCallbacks.clear();
    this.exitCallbacks.clear();
    this.initialized = false;
  }
}

/** Singleton instance used by Terminal components. */
export const terminalDispatcher = new TerminalOutputDispatcher();

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
