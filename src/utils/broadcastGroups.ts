/**
 * Pure helpers for persistent, named broadcast groups (PROD-061, #3443).
 *
 * A {@link BroadcastGroup} is a named set of **saved-connection ids**. Tab ids
 * are ephemeral (a new id every session), so a group resolves at use time to the
 * open terminal tabs opened from one of its connections. Tabs without a saved
 * connection (local shells, spawned containers, externally attached sessions)
 * cannot be members — resolution never falls back to fuzzy title matching,
 * because broadcasting keystrokes to the wrong host is the failure mode this
 * feature must never introduce.
 */
import type { BroadcastGroup, TerminalTab } from "@/types/terminal";

/** Maximum length of a broadcast group name. */
export const MAX_BROADCAST_GROUP_NAME_LENGTH = 60;

/** Normalize a user-entered group name (trim + collapse internal whitespace). */
export function normalizeBroadcastGroupName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Validate a group name, returning a user-facing error or `null` when valid.
 */
export function validateBroadcastGroupName(name: string): string | null {
  const normalized = normalizeBroadcastGroupName(name);
  if (normalized.length === 0) return "Enter a group name";
  if (normalized.length > MAX_BROADCAST_GROUP_NAME_LENGTH) {
    return `Group names are at most ${MAX_BROADCAST_GROUP_NAME_LENGTH} characters`;
  }
  return null;
}

/**
 * Split the selected terminal tabs into the de-duplicated saved-connection ids
 * that can be stored in a group, plus the number of selected tabs that have no
 * saved connection (and therefore cannot be stored).
 */
export function groupableConnectionIds(
  tabs: readonly TerminalTab[],
  selectedTabIds: Iterable<string>
): { connectionIds: string[]; unsavedCount: number } {
  const selected = new Set(selectedTabIds);
  const connectionIds: string[] = [];
  let unsavedCount = 0;
  for (const tab of tabs) {
    if (!selected.has(tab.id) || tab.contentType !== "terminal") continue;
    if (!tab.connectionId) {
      unsavedCount += 1;
      continue;
    }
    if (!connectionIds.includes(tab.connectionId)) connectionIds.push(tab.connectionId);
  }
  return { connectionIds, unsavedCount };
}

/** What a named group resolves to against the currently open tabs. */
export interface BroadcastGroupResolution {
  /** Open terminal tab ids opened from one of the group's connections (tab order). */
  tabIds: string[];
  /** The group's connection ids that have no open terminal tab right now. */
  missingConnectionIds: string[];
}

/**
 * Resolve a group against `tabs`: every terminal tab whose saved connection is a
 * member, in tab order, plus the members that are not open. A connection opened
 * in several tabs contributes every one of those tabs.
 */
export function resolveBroadcastGroup(
  tabs: readonly TerminalTab[],
  group: BroadcastGroup
): BroadcastGroupResolution {
  const members = new Set(group.connectionIds);
  const tabIds: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (tab.contentType !== "terminal" || !tab.connectionId) continue;
    if (!members.has(tab.connectionId)) continue;
    tabIds.push(tab.id);
    seen.add(tab.connectionId);
  }
  const missingConnectionIds = group.connectionIds.filter((id) => !seen.has(id));
  return { tabIds, missingConnectionIds };
}

/**
 * Return `groups` with a group named `name` holding `connectionIds`. A group with
 * the same name (case-insensitive) is replaced in place, keeping its id, so
 * "Save as group" with an existing name updates that group rather than creating
 * an indistinguishable duplicate. New groups are appended.
 */
export function upsertBroadcastGroup(
  groups: readonly BroadcastGroup[],
  name: string,
  connectionIds: readonly string[],
  newId: () => string
): BroadcastGroup[] {
  const normalized = normalizeBroadcastGroupName(name);
  const key = normalized.toLocaleLowerCase();
  const unique = [...new Set(connectionIds)];
  const index = groups.findIndex((g) => g.name.toLocaleLowerCase() === key);
  if (index >= 0) {
    const next = [...groups];
    next[index] = { id: groups[index].id, name: normalized, connectionIds: unique };
    return next;
  }
  return [...groups, { id: newId(), name: normalized, connectionIds: unique }];
}

/** Return `groups` without the group `id`. */
export function removeBroadcastGroup(
  groups: readonly BroadcastGroup[],
  id: string
): BroadcastGroup[] {
  return groups.filter((g) => g.id !== id);
}

/**
 * Drop malformed entries from a persisted `broadcastGroups` value (the settings
 * document is user-editable JSON), so a hand-edited file can never make the
 * resolver throw or silently target the wrong tabs.
 */
export function sanitizeBroadcastGroups(value: unknown): BroadcastGroup[] {
  if (!Array.isArray(value)) return [];
  const out: BroadcastGroup[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, name, connectionIds } = entry as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) continue;
    if (typeof name !== "string" || normalizeBroadcastGroupName(name).length === 0) continue;
    if (!Array.isArray(connectionIds)) continue;
    const ids = connectionIds.filter((c): c is string => typeof c === "string" && c.length > 0);
    out.push({ id, name: normalizeBroadcastGroupName(name), connectionIds: [...new Set(ids)] });
  }
  return out;
}
