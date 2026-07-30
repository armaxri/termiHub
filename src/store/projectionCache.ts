/**
 * Dumb projection-cache store for the stateless-UI substrate (#2149).
 *
 * Holds the last backend-pushed view model per region and notifies React; it
 * computes and decides nothing (the backend is the single authoritative
 * writer). A {@link ProjectionClient} drives one region into this store via
 * {@link connectRegion}.
 *
 * Phase-1 note: this lives adjacent to the 8k-line `appStore.ts` rather than
 * inside it. Phase 1 migrates no real domain, so there is no slice to convert
 * yet; when a domain migrates (Phase 2+), its `appStore` slice becomes a dumb
 * cache fed the same way. Keeping the generic cache separate keeps the Phase-1
 * change additive and low-blast-radius.
 */

import { create } from "zustand";

import { ProjectionClient } from "@/services/transport/ProjectionClient";
import type { Transport } from "@/services/transport/Transport";

/** Cached `{ version, view }` for a single region. */
export interface RegionCache {
  version: number;
  view: unknown;
}

interface ProjectionCacheStore {
  /** region id → last pushed view model + version. */
  regions: Record<string, RegionCache>;
  /** Replace a region's cached state (called by a {@link ProjectionClient}). */
  setRegion: (region: string, cache: RegionCache) => void;
  /** Drop a region from the cache (e.g. on unsubscribe). */
  clearRegion: (region: string) => void;
}

export const useProjectionCache = create<ProjectionCacheStore>((set) => ({
  regions: {},
  setRegion: (region, cache) =>
    set((state) => ({ regions: { ...state.regions, [region]: cache } })),
  clearRegion: (region) =>
    set((state) => {
      const regions = { ...state.regions };
      delete regions[region];
      return { regions };
    }),
}));

/**
 * Attach a region to the dumb projection cache: create a
 * {@link ProjectionClient}, pipe its changes into the store, and start it.
 * Resolves with the started client so the caller can `stop()` it on unmount.
 */
export async function connectRegion(
  transport: Transport,
  region: string
): Promise<ProjectionClient> {
  const client = new ProjectionClient(transport, region);
  client.onChange((state) => {
    useProjectionCache.getState().setRegion(region, state);
  });
  await client.start();
  return client;
}
