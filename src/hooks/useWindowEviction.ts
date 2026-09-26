import { useMemo } from "react";
import { useAppStore } from "@/store/appStore";
import { resolveWindowEviction, type ControllingWindow } from "@/utils/tabOwnership";

/**
 * The window that has taken over this tab's session, when that is a *different*
 * window than the one rendering the tab (#3368, SM-003 single-attach for
 * windows) — or `null` when this window controls (or may freely drive) it.
 *
 * Reactive over the store's `session → window` ownership mirror, which every
 * window keeps fresh from the backend's `session-ownership-changed` push. Selects
 * primitives only (never a fresh object) so the subscription stays stable.
 */
export function useWindowEviction(tabId: string): ControllingWindow | null {
  const sessionId = useAppStore((s) => s.tabContent[tabId]?.sessionId ?? null);
  const owner = useAppStore((s) => (sessionId ? s.sessionOwners[sessionId] : undefined));
  const windowLabel = useAppStore((s) => s.windowLabel);
  const moving = useAppStore((s) => (sessionId ? s.movingSessionIds.includes(sessionId) : false));
  return useMemo(
    () =>
      resolveWindowEviction({
        sessionId,
        sessionOwners: sessionId && owner ? { [sessionId]: owner } : {},
        windowLabel,
        moving,
      }),
    [sessionId, owner, windowLabel, moving]
  );
}
