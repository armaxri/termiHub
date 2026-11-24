import type { AppState } from "./appStore";
import { collectLiveTabs } from "./layoutHelpers";
import { readConfigString } from "@/utils/connectionConfigFields";

/**
 * The live desktop sessions of `agentId`'s open terminal tabs, by tab id
 * (#5960): the tabs whose connection runs through that agent and that
 * hold a session right now.
 */
export function agentTabSessions(
  state: AppState,
  agentId: string
): Array<{ tabId: string; sessionId: string }> {
  return collectLiveTabs(state)
    .filter(
      (tab) =>
        tab.contentType === "terminal" &&
        !!tab.sessionId &&
        readConfigString(tab.config, "agentId") === agentId
    )
    .map((tab) => ({ tabId: tab.id, sessionId: tab.sessionId as string }));
}
