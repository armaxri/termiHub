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

/**
 * Resolve whether this window is **evicted** from a session it renders (#3368,
 * SM-003 single-attach for windows): another window has taken the session over.
 *
 * Only one window controls a session. When a different window claims it (an
 * explicit take-over), this window keeps rendering the tab but shows the
 * "Taken over by another window" overlay with a Reclaim button; its input and
 * resize are dropped (here and, authoritatively, in the backend `may_send_input`
 * / `may_resize` guards). Returns the controlling window, or `null` when this
 * window controls the session. `null` also when:
 *
 *  - the tab carries no session id,
 *  - the session is unclaimed (absent from the ownership map — any window may
 *    drive it, e.g. after the controlling window closed), or
 *  - the session is mid-move to another window (the source tab is on its way
 *    out; the move is not a take-over).
 *
 * Unlike {@link resolveControllingWindow} this does not gate on the window
 * count: a session owned by a different window is evicted here regardless of
 * how fresh this window's view of the window set is.
 */
export function resolveWindowEviction(params: {
  sessionId: string | null | undefined;
  sessionOwners: Record<string, string>;
  windowLabel: string;
  moving?: boolean;
}): ControllingWindow | null {
  const { sessionId, sessionOwners, windowLabel, moving } = params;
  if (!sessionId || moving) return null;
  const owner = sessionOwners[sessionId];
  if (!owner || owner === windowLabel) return null;
  return { label: owner, name: windowDisplayName(owner) };
}
