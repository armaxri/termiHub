import { StateCreator } from "zustand";

import {
  getSessionHistory,
  recordSession as apiRecordSession,
  setHistoryEntryPinned as apiSetHistoryEntryPinned,
  markHistoryEntryPromoted as apiMarkHistoryEntryPromoted,
  removeHistoryEntry as apiRemoveHistoryEntry,
  clearSessionHistory as apiClearSessionHistory,
} from "@/services/sessionHistoryApi";
import { currentSettingsView } from "@/store/settingsBridge";
import { ConnectionConfig } from "@/types/terminal";
import { SessionHistoryEntry } from "@/types/sessionHistory";
import { frontendLog } from "@/utils/frontendLog";
import { sessionHistoryTitle } from "@/utils/sessionHistoryTitle";

import type { AppState } from "../appStore";

/**
 * Recent-session history domain slice (#1883, extracted under #2077): the
 * recorded-session list plus the load/record/pin/promote/remove/clear actions
 * that drive it. Extracted verbatim from the monolithic root store as a
 * behavior-preserving Zustand slice — every action still receives the shared
 * `set`/`get` typed against the full {@link AppState}, so the public store shape
 * and behavior are unchanged. Mirrors the SSH tunnel slice (#2077) and the
 * embedded-server / macros / plugins slices (#2113/#2114/#2115).
 */

/** Secret fields that must never be written to session history. */
const HISTORY_SECRET_KEYS = ["password", "passphrase", "keyPassphrase"];

/**
 * Return a copy of a connection config with all secret fields removed, for
 * safe storage in the session history (which never holds credentials).
 */
function stripHistorySecrets(config: ConnectionConfig): ConnectionConfig {
  const inner = { ...(config.config as Record<string, unknown>) };
  for (const key of HISTORY_SECRET_KEYS) {
    delete inner[key];
  }
  return { type: config.type, config: inner };
}

export interface SessionHistorySlice {
  /** Recorded session history, ordered pinned-first then most-recently-used. */
  sessionHistory: SessionHistoryEntry[];
  /** Load session history from the backend. */
  loadSessionHistory: () => Promise<void>;
  /**
   * Record a session open in history (deduplicated + evicted in the backend).
   * A no-op when `sessionHistoryEnabled` is off. Failures are logged, not thrown.
   */
  recordSession: (connectionType: string, config: ConnectionConfig) => Promise<void>;
  /** Pin or unpin a history entry. */
  pinHistoryEntry: (dedupKey: string, pinned: boolean) => Promise<void>;
  /** Mark a history entry as promoted to a saved connection. */
  markHistoryPromoted: (dedupKey: string) => Promise<void>;
  /** Remove a single history entry. */
  removeHistoryEntry: (dedupKey: string) => Promise<void>;
  /** Clear all session history. */
  clearSessionHistory: () => Promise<void>;
}

export const createSessionHistorySlice: StateCreator<AppState, [], [], SessionHistorySlice> = (
  set
) => ({
  sessionHistory: [],

  loadSessionHistory: async () => {
    try {
      const entries = await getSessionHistory();
      set({ sessionHistory: entries });
    } catch (err) {
      frontendLog(
        "session_history",
        `Failed to load session history: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  recordSession: async (connectionType, config) => {
    const settings = currentSettingsView();
    if (settings.sessionHistoryEnabled === false) return;
    // Privacy: passwords/passphrases are NEVER written to history, regardless
    // of the connection's savePassword flag (they live in the credential store).
    const safeConfig = stripHistorySecrets(config);
    const title = sessionHistoryTitle(connectionType, safeConfig);
    const limit = settings.sessionHistoryLimit ?? 50;
    try {
      const entries = await apiRecordSession(connectionType, safeConfig, title, limit);
      set({ sessionHistory: entries });
    } catch (err) {
      frontendLog(
        "session_history",
        `Failed to record session: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },

  pinHistoryEntry: async (dedupKey, pinned) => {
    const entries = await apiSetHistoryEntryPinned(dedupKey, pinned);
    set({ sessionHistory: entries });
  },

  markHistoryPromoted: async (dedupKey) => {
    const entries = await apiMarkHistoryEntryPromoted(dedupKey);
    set({ sessionHistory: entries });
  },

  removeHistoryEntry: async (dedupKey) => {
    const entries = await apiRemoveHistoryEntry(dedupKey);
    set({ sessionHistory: entries });
  },

  clearSessionHistory: async () => {
    const entries = await apiClearSessionHistory();
    set({ sessionHistory: entries });
  },
});
