/**
 * Persistent named broadcast groups — store-side glue (PROD-061, #3443).
 *
 * Groups live in the persisted settings document (`AppSettings.broadcastGroups`)
 * so they survive restarts, sync across windows through the authoritative
 * `settings` region, and travel with settings export/import. The backend keeps
 * the key verbatim via `AppSettings.extra`, so no backend schema change is needed.
 * The pure membership logic lives in {@link import("@/utils/broadcastGroups")}.
 */
import { useMemo } from "react";

import { newId } from "@/services/transport/ids";
import type { BroadcastGroup } from "@/types/terminal";
import {
  normalizeBroadcastGroupName,
  removeBroadcastGroup,
  sanitizeBroadcastGroups,
  upsertBroadcastGroup,
} from "@/utils/broadcastGroups";

import { useAppStore } from "./appStore";
import { currentSettingsView } from "./settingsBridge";
import { useProjectedSettings } from "./useProjectedSettings";

/** The saved broadcast groups (sanitized), for synchronous store-side reads. */
export function currentBroadcastGroups(): BroadcastGroup[] {
  return sanitizeBroadcastGroups(currentSettingsView().broadcastGroups);
}

/** The saved broadcast groups (sanitized), re-rendering on settings changes. */
export function useBroadcastGroups(): BroadcastGroup[] {
  const raw = useProjectedSettings().broadcastGroups;
  return useMemo(() => sanitizeBroadcastGroups(raw), [raw]);
}

async function persistGroups(groups: BroadcastGroup[]): Promise<void> {
  await useAppStore
    .getState()
    .updateSettings({ ...currentSettingsView(), broadcastGroups: groups });
}

/**
 * Save `connectionIds` as the group `name` (replacing a same-named group) and
 * return the saved group.
 */
export async function saveBroadcastGroup(
  name: string,
  connectionIds: readonly string[]
): Promise<BroadcastGroup> {
  const next = upsertBroadcastGroup(currentBroadcastGroups(), name, connectionIds, () =>
    newId("bcg")
  );
  await persistGroups(next);
  const key = normalizeBroadcastGroupName(name).toLocaleLowerCase();
  // upsert always yields a group with this (normalized) name.
  return next.find((g) => g.name.toLocaleLowerCase() === key) as BroadcastGroup;
}

/** Delete the group `id` (no-op when it does not exist). */
export async function deleteBroadcastGroup(id: string): Promise<void> {
  const groups = currentBroadcastGroups();
  if (!groups.some((g) => g.id === id)) return;
  await persistGroups(removeBroadcastGroup(groups, id));
}
