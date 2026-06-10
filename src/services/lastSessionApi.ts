/**
 * Tauri command wrappers for last-session (auto-saved layout) operations.
 */

import { invoke } from "@tauri-apps/api/core";
import { LastSession } from "@/types/lastSession";

/** Persist the current session for restore on the next startup. */
export async function saveLastSession(session: LastSession): Promise<void> {
  await invoke("save_last_session", { session });
}

/** Load the persisted last session, or `null` when there is nothing to restore. */
export async function loadLastSession(): Promise<LastSession | null> {
  return await invoke<LastSession | null>("load_last_session");
}

/** Clear the persisted last session. */
export async function clearLastSession(): Promise<void> {
  await invoke("clear_last_session");
}
