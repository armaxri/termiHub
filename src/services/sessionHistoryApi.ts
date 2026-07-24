/**
 * Tauri command wrappers for session-history operations.
 *
 * Every mutating command returns the full, display-ordered entry list so the
 * store can replace its copy wholesale (deduplication and eviction happen in the
 * backend).
 */

import { invoke } from "@tauri-apps/api/core";
import { ConnectionConfig } from "@/types/terminal";
import { SessionHistoryEntry } from "@/types/sessionHistory";

/** List all history entries (pinned first, then most recently used). */
export async function getSessionHistory(): Promise<SessionHistoryEntry[]> {
  return await invoke<SessionHistoryEntry[]>("get_session_history");
}

/**
 * Record a session open (deduplicated), trimming history to `limit`.
 * Returns the full updated list.
 */
export async function recordSession(
  connectionType: string,
  config: ConnectionConfig,
  title: string,
  limit: number
): Promise<SessionHistoryEntry[]> {
  return await invoke<SessionHistoryEntry[]>("record_session", {
    connectionType,
    config,
    title,
    limit,
  });
}

/** Pin or unpin a history entry. */
export async function setHistoryEntryPinned(
  dedupKey: string,
  pinned: boolean
): Promise<SessionHistoryEntry[]> {
  return await invoke<SessionHistoryEntry[]>("set_history_entry_pinned", { dedupKey, pinned });
}

/** Mark a history entry as promoted to a saved connection. */
export async function markHistoryEntryPromoted(
  dedupKey: string
): Promise<SessionHistoryEntry[]> {
  return await invoke<SessionHistoryEntry[]>("mark_history_entry_promoted", { dedupKey });
}

/** Remove a single history entry. */
export async function removeHistoryEntry(dedupKey: string): Promise<SessionHistoryEntry[]> {
  return await invoke<SessionHistoryEntry[]>("remove_history_entry", { dedupKey });
}

/** Clear all session history. */
export async function clearSessionHistory(): Promise<SessionHistoryEntry[]> {
  return await invoke<SessionHistoryEntry[]>("clear_session_history");
}
