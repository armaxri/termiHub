/**
 * Pure helpers for the `agent-state-change` handler in {@link TerminalView}.
 *
 * Extracted so the branch logic can be unit-tested directly against the store
 * without rendering the whole component (avoids simulation drift — the real
 * handler and the tests exercise the exact same code).
 */
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { frontendLog } from "@/utils/frontendLog";

/**
 * Apply the agent `reconnecting` transition to every terminal tab owned by the
 * agent (G8, #1242).
 *
 * Two cases, so every agent tab gets honest feedback during a drop:
 * - **Live-session tabs** (`sessionId` set): the shared `session-lifecycle`
 *   region — the sole reconnecting source for the overlay + tab-strip dot — is
 *   folded to `reconnecting` **server-side** by `agent_io_task` at the source of
 *   the transient break (#2556), so no client fold happens here; the frontend
 *   only tracks the count for the log.
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
  _error: string | undefined
): void {
  const store = useAppStore.getState();
  let reconnectingCount = 0;
  let waitingCount = 0;
  for (const tab of agentTerminalTabs) {
    if (tab.sessionId) {
      // Live session — the backend `agent_io_task` folds this tab's region entry
      // to `reconnecting` at the source of the transient break (#2556), so the
      // client no longer mirrors it. The overlay + tab-strip dot already source
      // `reconnecting` purely from the region (#2554/#2205 PR-B), so the server
      // fold is all that is needed; the trigger error is folded there too.
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
