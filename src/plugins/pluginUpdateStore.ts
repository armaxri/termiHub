/**
 * Frontend state for the opt-in plugin update check (PROD-051).
 *
 * termiHub never updates a plugin silently. A plugin that declares an HTTPS
 * `updateUrl` can be checked — manually from the Plugins view / detail panel, or
 * periodically when the user turned that on — and the result is kept here so
 * the list row badge and the detail panel agree. Installing an offered update
 * always goes through the normal install dialog (see `PluginUpdateSection`).
 *
 * Standalone (not an `appStore` slice): the state is purely derived UI state
 * for one feature and is never persisted.
 */
import { create } from "zustand";
import { checkPluginUpdates } from "@/services/api";
import type { InstalledPlugin, PluginUpdateCheckOutcome } from "@/types/plugin";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";

/** One plugin's update-check state. */
export type PluginUpdateEntry =
  | { phase: "checking" }
  | { phase: "checked"; outcome: PluginUpdateCheckOutcome }
  | { phase: "error"; error: string };

/** The update-check store. */
export interface PluginUpdateState {
  /** Per-plugin check state, keyed by plugin id. */
  entries: Record<string, PluginUpdateEntry>;
  /** Whether a check of every plugin is running. */
  checkingAll: boolean;
  /** When the last check of every plugin finished (ms since epoch), if ever. */
  lastCheckedAt: number | null;
  /**
   * Check `pluginIds` (every plugin with an `updateUrl` when omitted). Never
   * throws: a failed check is recorded as an `error` entry.
   */
  checkForUpdates: (pluginIds?: string[]) => Promise<void>;
}

/** Whether `plugin` opted in to update checks. */
export function hasUpdateSource(plugin: InstalledPlugin): boolean {
  return typeof plugin.manifest.updateUrl === "string" && plugin.manifest.updateUrl !== "";
}

export const usePluginUpdateStore = create<PluginUpdateState>((set) => ({
  entries: {},
  checkingAll: false,
  lastCheckedAt: null,

  checkForUpdates: async (pluginIds) => {
    const all = pluginIds === undefined;
    set((s) => {
      const entries = { ...s.entries };
      for (const id of pluginIds ?? []) entries[id] = { phase: "checking" };
      return { entries, checkingAll: all || s.checkingAll };
    });

    const next: Record<string, PluginUpdateEntry> = {};
    try {
      const batches = all ? [undefined] : pluginIds;
      for (const id of batches) {
        for (const result of await checkPluginUpdates(id)) {
          next[result.pluginId] = result.outcome
            ? { phase: "checked", outcome: result.outcome }
            : { phase: "error", error: result.error ?? "Update check failed" };
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      frontendLog("plugin_update", `Update check failed: ${message}`);
      for (const id of pluginIds ?? []) next[id] = { phase: "error", error: message };
    }

    set((s) => ({
      entries: { ...s.entries, ...next },
      checkingAll: all ? false : s.checkingAll,
      lastCheckedAt: all ? Date.now() : s.lastCheckedAt,
    }));
  },
}));

/**
 * The entry for `plugin` if it still describes the installed version. An
 * outcome computed against an older installed version (the plugin has been
 * updated since) is stale and hidden.
 */
export function currentEntry(
  entries: Record<string, PluginUpdateEntry>,
  plugin: InstalledPlugin
): PluginUpdateEntry | undefined {
  const entry = entries[plugin.manifest.id];
  if (entry?.phase === "checked" && entry.outcome.installedVersion !== plugin.manifest.version) {
    return undefined;
  }
  return entry;
}

/** Whether `plugin` has a downloadable update according to `entries`. */
export function hasAvailableUpdate(
  entries: Record<string, PluginUpdateEntry>,
  plugin: InstalledPlugin
): boolean {
  const entry = currentEntry(entries, plugin);
  return entry?.phase === "checked" && entry.outcome.status === "updateAvailable";
}
