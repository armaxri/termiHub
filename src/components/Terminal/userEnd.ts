import { hasAgentDisconnectIntent } from "@/store/agentDisconnectIntent";
import { useAppStore } from "@/store/appStore";
import { currentSessionView } from "@/store/sessionBridge";

/**
 * Whether a session exit on `tabId` is the user's end of its agent (#5959), so
 * the tab reads "disconnected by you", not "connection lost". A user agent
 * Disconnect or Shutdown closes the hosted sessions, and their exits arrive as
 * plain drops; any of these says the user ended them:
 *
 * - this window's user is disconnecting the tab's agent (`agentId`) and the
 *   "disconnected" event has not landed yet;
 * - the event landed and ended the tab here (`terminalAgentDisconnected`);
 * - the backend folded the tab's user end (#4459), which it does before the
 *   sessions close — in every window, also one whose user did not click.
 */
export function sessionEndedByUser(tabId: string, agentId?: string): boolean {
  if (useAppStore.getState().terminalAgentDisconnected[tabId]) return true;
  if (agentId && hasAgentDisconnectIntent(agentId)) return true;
  const session = currentSessionView()[tabId];
  return session?.status === "disconnected" && session.endReason === "user";
}
