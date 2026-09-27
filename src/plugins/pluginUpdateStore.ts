/**
 * Frontend state for the opt-in plugin update check (PROD-051, #3717).
 *
 * termiHub never updates a plugin silently. Updates come from two sources:
 *
 * - a plugin's own HTTPS `updateUrl` (checked per plugin), and
 * - the curated plugin index (PROD-048), fetched by the backend.
 *
 * Both are checked manually from the Plugins view / detail panel, or
 * periodically when the user turned that on, and the result is kept here so the
 * list row badge and the detail panel agree. The index's compatibility verdict
 * (ABI, platform, toolchain) is computed by the backend; only an index entry
 * that is strictly newer than the installed version **and** installable on this
 * computer is recorded as an offer. When both sources offer an update, the
 * strictly greater version wins and a tie goes to the plugin's own `updateUrl`
 * (see {@link effectiveUpdate}). Installing an offered update always goes
 * through the normal install dialog (see `PluginUpdateSection`).
 *
 * Standalone (not an `appStore` slice): the state is purely derived UI state
 * for one feature and is never persisted.
 */
import { create } from "zustand";
import { checkPluginUpdates, fetchPluginIndex } from "@/services/api";
import type {
  InstalledPlugin,
  PluginIndexEntryView,
  PluginIndexResult,
  PluginUpdateCheckOutcome,
} from "@/types/plugin";
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
  /**
   * Compatible, strictly newer versions the plugin index offers, keyed by
   * plugin id. Replaced as a whole by every successful index fetch.
   */
  indexOffers: Record<string, PluginIndexEntryView>;
  /** Whether a plugin-index fetch is running. */
  checkingIndex: boolean;
  /** Why the last plugin-index fetch failed, or `null`. */
  indexError: string | null;
  /**
   * Fetch the plugin index (in the backend) and record its update offers.
   * Never throws: a failure is kept in `indexError`, previous offers stay.
   */
  checkIndexForUpdates: () => Promise<void>;
  /** Record the offers of an index that was fetched elsewhere (Browse Plugins). */
  recordIndex: (result: PluginIndexResult) => void;
}

/** The offers in an index result: installable entries newer than the installed copy. */
export function indexOffersFrom(result: PluginIndexResult): Record<string, PluginIndexEntryView> {
  const offers: Record<string, PluginIndexEntryView> = {};
  for (const view of result.entries) {
    if (view.installStatus === "updateAvailable" && view.installable) {
      offers[view.entry.id] = view;
    }
  }
  return offers;
}

/** Whether `plugin` opted in to update checks. */
export function hasUpdateSource(plugin: InstalledPlugin): boolean {
  return typeof plugin.manifest.updateUrl === "string" && plugin.manifest.updateUrl !== "";
}

export const usePluginUpdateStore = create<PluginUpdateState>((set, get) => ({
  entries: {},
  checkingAll: false,
  lastCheckedAt: null,
  indexOffers: {},
  checkingIndex: false,
  indexError: null,

  recordIndex: (result) => set({ indexOffers: indexOffersFrom(result), indexError: null }),

  checkIndexForUpdates: async () => {
    set({ checkingIndex: true });
    try {
      const result = await fetchPluginIndex();
      set({ indexOffers: indexOffersFrom(result), indexError: null, checkingIndex: false });
    } catch (err) {
      const message = errorMessage(err);
      frontendLog("plugin_update", `Plugin index check failed: ${message}`);
      set({ indexError: message, checkingIndex: false });
    }
  },

  checkForUpdates: async (pluginIds) => {
    const all = pluginIds === undefined;
    // A check of every plugin also asks the plugin index (backend fetch).
    const indexCheck = all ? get().checkIndexForUpdates() : Promise.resolve();
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

    await indexCheck;

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

/**
 * The index offer for `plugin` if it still describes the installed version
 * (an offer computed before the plugin was updated is stale and hidden).
 */
export function currentIndexOffer(
  offers: Record<string, PluginIndexEntryView>,
  plugin: InstalledPlugin
): PluginIndexEntryView | undefined {
  const offer = offers[plugin.manifest.id];
  if (!offer || offer.installedVersion !== plugin.manifest.version) return undefined;
  return offer;
}

/** Which source an offered update comes from, and its version. */
export type EffectiveUpdate =
  | { source: "updateUrl"; version: string; outcome: PluginUpdateCheckOutcome }
  | { source: "index"; version: string; offer: PluginIndexEntryView };

/**
 * The update to offer for `plugin`, or `null` when neither source offers one.
 *
 * Precedence (documented in `docs/plugin-authoring.md`): each source only ever
 * offers a strictly newer, compatible version. When both do, the **strictly
 * greater version wins**; on a tie (or when the versions cannot be compared)
 * the plugin's own `updateUrl` wins, since it is the publisher's channel.
 */
export function effectiveUpdate(
  entries: Record<string, PluginUpdateEntry>,
  offers: Record<string, PluginIndexEntryView>,
  plugin: InstalledPlugin
): EffectiveUpdate | null {
  const entry = currentEntry(entries, plugin);
  const own =
    entry?.phase === "checked" && entry.outcome.status === "updateAvailable" ? entry.outcome : null;
  const offer = currentIndexOffer(offers, plugin);
  if (own && (!offer || compareSemver(offer.entry.version, own.latestVersion) !== 1)) {
    return { source: "updateUrl", version: own.latestVersion, outcome: own };
  }
  if (offer) return { source: "index", version: offer.entry.version, offer };
  return null;
}

/** Whether `plugin` has a downloadable update from either source. */
export function hasAvailableUpdate(
  entries: Record<string, PluginUpdateEntry>,
  plugin: InstalledPlugin,
  offers: Record<string, PluginIndexEntryView> = {}
): boolean {
  return effectiveUpdate(entries, offers, plugin) !== null;
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver precedence of `a` against `b`: `1` greater, `-1` less, `0` equal, or
 * `null` when either is not a valid semver (build metadata is ignored).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = SEMVER.exec(a.trim());
  const pb = SEMVER.exec(b.trim());
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const ra = pa[4];
  const rb = pb[4];
  if (ra === undefined || rb === undefined) {
    if (ra === rb) return 0;
    // A release outranks any pre-release of the same version.
    return ra === undefined ? 1 : -1;
  }
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb) {
      const d = Number(xa[i]) - Number(xb[i]);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (xa[i] !== xb[i]) {
      return xa[i] < xb[i] ? -1 : 1;
    }
  }
  return 0;
}
