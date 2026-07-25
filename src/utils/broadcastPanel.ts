/**
 * Broadcast panel-ring helper (#1957, epic #1954).
 *
 * The ring/glow a panel shows tracks its *visible* (active) tab, not any
 * inactive participant hidden behind it: the panel whose active tab is the
 * broadcast source gets the source class (ring + glow), a panel whose active tab
 * is any other target gets the target class (ring only), and everything else
 * gets no class.
 */

/** The broadcast store slice this helper reads (#1955). */
export interface BroadcastPanelState {
  broadcastActive: boolean;
  broadcastSourceTabId: string | null;
  broadcastTargetTabIds: Set<string>;
}

/** CSS modifier for the panel wrapper, or `""` when the panel is not participating. */
export type BroadcastPanelClass = "" | "panel--broadcast-source" | "panel--broadcast-target";

/**
 * Resolve the broadcast ring class for a panel currently showing `activeTabId`.
 *
 * @param activeTabId The panel's visible tab id (`null` when the panel is empty).
 * @param broadcast The broadcast store slice.
 * @returns `panel--broadcast-source`, `panel--broadcast-target`, or `""`.
 */
export function broadcastPanelClass(
  activeTabId: string | null,
  broadcast: BroadcastPanelState
): BroadcastPanelClass {
  const { broadcastActive, broadcastSourceTabId, broadcastTargetTabIds } = broadcast;
  if (!broadcastActive || !activeTabId) return "";
  if (activeTabId === broadcastSourceTabId) return "panel--broadcast-source";
  if (broadcastTargetTabIds.has(activeTabId)) return "panel--broadcast-target";
  return "";
}
