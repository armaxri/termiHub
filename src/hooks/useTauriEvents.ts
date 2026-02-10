/**
 * Hook for subscribing to Tauri backend events.
 * Phase 1: Stub. Phase 2 will subscribe to terminal-output, terminal-exit events.
 */
export function useTauriEvents() {
  // Phase 2: Will use @tauri-apps/api/event to listen for:
  // - "terminal-output" -> write to xterm
  // - "terminal-exit" -> update tab state
  // - "terminal-error" -> show notification
}
