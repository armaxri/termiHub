/**
 * Tauri event listener setup.
 * Phase 1: Stub. Phase 2 will use @tauri-apps/api/event.
 */

type UnlistenFn = () => void;

/** Subscribe to terminal output events */
export function onTerminalOutput(
  _callback: (sessionId: string, data: Uint8Array) => void
): UnlistenFn {
  // Phase 2: return listen("terminal-output", callback);
  return () => {};
}

/** Subscribe to terminal exit events */
export function onTerminalExit(
  _callback: (sessionId: string, exitCode: number | null) => void
): UnlistenFn {
  // Phase 2: return listen("terminal-exit", callback);
  return () => {};
}
