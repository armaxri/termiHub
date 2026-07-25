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
 *   **terminated**.
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
 * outcomes. Tabs without a backend `sessionId` are ignored (nothing to lose).
 *
 * Mirrors the teardown rule used when the app closes all sessions: a tab with a
 * `persistentConnectionId` detaches (keeps running); every other live tab would
 * be terminated.
 */
export function classifyWindowCloseSessions(tabs: TerminalTab[]): WindowCloseSessionRow[] {
  return tabs
    .filter((tab): tab is TerminalTab & { sessionId: string } => Boolean(tab.sessionId))
    .map((tab) => ({
      tabId: tab.id,
      sessionId: tab.sessionId,
      title: tab.title,
      connectionType: tab.connectionType,
      contentType: tab.contentType,
      outcome: tab.persistentConnectionId ? "detach" : "terminate",
    }));
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
