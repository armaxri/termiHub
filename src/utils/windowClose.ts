/**
 * Close-with-live-tabs classification (#1903, epic #1899).
 *
 * When a native window that still owns live sessions is closed, termiHub must
 * not silently kill those sessions. Each owned session is classified by whether
 * closing would lose it:
 *
 * - **persistent / agent** sessions (`persistentConnectionId` set) **detach** —
 *   the backend process keeps running and can be re-attached later, so nothing
 *   is lost;
 * - **non-persistent** sessions (local shell, serial, one-shot SSH, …) would be
 *   **terminated**;
 * - a connection that is still **starting** (#5112) is ended too, so it is
 *   listed with the terminate outcome rather than skipped.
 *
 * The decision surface (`CloseWindowDecisionDialog`) appears only when something
 * would actually be lost — i.e. at least one `terminate`. See
 * `docs/concepts/implemented/multi-window.html` → "Closing a window that owns live
 * tabs".
 */

import type { TerminalTab } from "@/types/terminal";
import type { WindowCloseSessionRow } from "@/types/window";

/**
 * Classify the live (session-bearing) tabs of a window into per-session close
 * outcomes, plus the tabs whose connection is still starting.
 *
 * Mirrors the teardown rule used when the app closes all sessions: a tab with a
 * `persistentConnectionId` detaches (keeps running); every other live tab would
 * be terminated.
 *
 * A tab whose `create_connection` is still in flight has no `sessionId` yet but
 * holds a connection the user asked for (#5112). When its id is in
 * `startingTabIds` it is listed as `starting` with the `terminate` outcome: the
 * close ends it, and a connection that finishes starting afterwards is closed
 * at once. Any other tab without a `sessionId` is ignored (nothing to lose).
 */
export function classifyWindowCloseSessions(
  tabs: TerminalTab[],
  startingTabIds: ReadonlySet<string> = new Set()
): WindowCloseSessionRow[] {
  return tabs.flatMap((tab): WindowCloseSessionRow[] => {
    const display = {
      tabId: tab.id,
      title: tab.title,
      connectionType: tab.connectionType,
      contentType: tab.contentType,
    };
    if (tab.sessionId) {
      return [
        {
          ...display,
          sessionId: tab.sessionId,
          outcome: tab.persistentConnectionId ? "detach" : "terminate",
        },
      ];
    }
    if (startingTabIds.has(tab.id)) {
      return [{ ...display, sessionId: null, starting: true, outcome: "terminate" }];
    }
    return [];
  });
}

/**
 * Whether closing a window with these classified sessions would lose data —
 * true when at least one session would be terminated. Drives the "raise the
 * dialog only when something is lost" branch: an empty or all-persistent window
 * closes without a prompt.
 */
export function windowCloseWouldLoseData(sessions: WindowCloseSessionRow[]): boolean {
  return sessions.some((session) => session.outcome === "terminate");
}
