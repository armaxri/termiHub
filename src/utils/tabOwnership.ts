import { windowDisplayName } from "@/utils/windowPicker";

/** A window (other than this one) that currently controls a rendered session (#2872). */
export interface ControllingWindow {
  /** Runtime label of the controlling window (`main`, `win-1`, …). */
  label: string;
  /** Human-readable name, e.g. "Main Window" / "Window 2". */
  name: string;
}

/**
 * Resolve the window that controls a tab's session when that window is a
 * *different* one than the window rendering the tab (#2872, follow-up to SM-026).
 *
 * In multi-window mode a session has a single owning window (the backend
 * `session → window` map, mirrored into the store's `sessionOwners` and kept
 * fresh by `session-ownership-changed`). A window that renders a session it does
 * not own has resize disabled for it, so its tab shows a persistent
 * "controlled by another window" badge. Returns `null` — no badge — when:
 *
 *  - only one window is open (single-window users see no change),
 *  - the tab carries no session id (non-terminal tabs),
 *  - the session is unclaimed (absent from the ownership map), or
 *  - this window is the owner.
 */
export function resolveControllingWindow(params: {
  sessionId: string | null | undefined;
  sessionOwners: Record<string, string>;
  windowLabel: string;
  multiWindow: boolean;
}): ControllingWindow | null {
  const { sessionId, sessionOwners, windowLabel, multiWindow } = params;
  if (!multiWindow || !sessionId) return null;
  const owner = sessionOwners[sessionId];
  if (!owner || owner === windowLabel) return null;
  return { label: owner, name: windowDisplayName(owner) };
}
