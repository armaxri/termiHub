import type { TerminalTab } from "@/types/terminal";
import { readConfigString } from "@/utils/connectionConfigFields";

/**
 * How many of `tabs` are terminal sessions on the remote agent `agentId`
 * (#5821): the open terminal tabs whose connection runs through that agent (an
 * agent shell, a saved connection on the agent). The update notice names this
 * count before an apply, because the agent waits for its sessions to close
 * before it restarts.
 */
export function countAgentSessionTabs(tabs: readonly TerminalTab[], agentId: string): number {
  return tabs.filter(
    (tab) => tab.contentType === "terminal" && readConfigString(tab.config, "agentId") === agentId
  ).length;
}
