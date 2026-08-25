/**
 * Pure helpers for the `agent-state-change` handler in {@link TerminalView}.
 *
 * Extracted so the branch logic can be unit-tested directly against the store
 * without rendering the whole component (avoids simulation drift — the real
 * handler and the tests exercise the exact same code).
 */
import { useAppStore } from "@/store/appStore";
import { mirrorSessionIntent, sessionIntentsEnabled } from "@/store/sessionBridge";
import { TerminalTab } from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Apply the agent `reconnecting` transition to every terminal tab owned by the
 * agent (G8, #1242).
 *
 * Two cases, so every agent tab gets honest feedback during a drop:
 * - **Live-session tabs** (`sessionId` set): show the reconnecting spinner
 *   overlay, recording the trigger error when one is supplied.
 * - **Spawning tabs** (still mid `connection.create`, no `sessionId` yet): park
 *   them on the waiting-for-agent path so they retry once the agent is back,
 *   instead of being skipped and landing on an ambiguous spawn error.
 *
 * @param agentId The agent whose link is reconnecting.
 * @param agentTerminalTabs Terminal tabs belonging to this agent (pre-filtered).
 * @param error Optional error that triggered the reconnect.
 */
export function applyAgentReconnecting(
  agentId: string,
  agentTerminalTabs: TerminalTab[],
  error: string | undefined
): void {
  const store = useAppStore.getState();
  let reconnectingCount = 0;
  let waitingCount = 0;
  for (const tab of agentTerminalTabs) {
    if (tab.sessionId) {
      // Live session — show the reconnecting spinner overlay.
      store.setTerminalReconnecting(tab.id, true);
      if (error) {
        store.setTerminalReconnectTriggerError(tab.id, error);
      }
      // Fold the shared `session-lifecycle` region to `reconnecting` for this tab
      // (#2555). The overlay + tab-strip dot source `reconnecting` purely from the
      // region after #2554, but a transient agent-transport break — recovered in
      // place by the agent I/O task's in-task reconnect loop — never folds the
      // region (no per-session `terminal-exit`), so those readers were stranded
      // (the #2554 regression). This status-only fold keeps the reconnect loop
      // idle, so the backend timer never arms a redrive that would double-drive
      // the transport the agent is already re-establishing. Optimistically folded,
      // so the overlay is gap-free; resolved back by the `connected` (survived) /
      // `disconnected` (gone) handlers in TerminalView.
      if (sessionIntentsEnabled()) {
        mirrorSessionIntent("session.agentTransportReconnecting", tab.id, error);
      }
      reconnectingCount++;
    } else {
      // Still spawning (no sessionId yet): park on the waiting path so the tab
      // retries once the agent reconnects, rather than surfacing a spawn error.
      store.setTerminalWaitingForAgent(tab.id, agentId);
      waitingCount++;
    }
  }
  frontendLog(
    "disconnect",
    `agent reconnecting: ${reconnectingCount} tabs marked reconnecting, ` +
      `${waitingCount} spawning tabs parked waiting for agent=${agentId}`
  );
}
