import { useEffect, useState } from "react";
import { agentSessionIds } from "@/services/api";
import { agentTabSessions } from "@/store/agentHostedSessions";
import { useAppStore } from "@/store/appStore";
import { getComposedLayout } from "@/store/layoutHelpers";
import { errorMessage } from "@/utils/errorMessage";
import { frontendLog } from "@/utils/frontendLog";
import { findLeafByTab } from "@/utils/panelTree";

const NO_TABS: ReadonlyMap<string, string> = new Map();

/**
 * The open tabs showing one of `agentId`'s sessions, keyed by the agent's own
 * session id (#5960): "Active sessions" marks those rows and activating one
 * focuses its tab. The tabs know only their desktop session ids, so the
 * backend maps them; `refreshKey` (the listed sessions) asks again when the
 * agent's list changes.
 */
export function useOpenAgentSessionTabs(
  agentId: string,
  refreshKey: unknown
): ReadonlyMap<string, string> {
  // A string, so the selector is stable while the agent's tabs stay the same.
  const key = useAppStore((s) => JSON.stringify(agentTabSessions(s, agentId)));
  const [tabs, setTabs] = useState<ReadonlyMap<string, string>>(NO_TABS);

  useEffect(() => {
    const pairs = JSON.parse(key) as Array<{ tabId: string; sessionId: string }>;
    if (pairs.length === 0) {
      setTabs(NO_TABS);
      return;
    }
    let cancelled = false;
    Promise.resolve()
      .then(() => agentSessionIds(pairs.map((p) => p.sessionId)))
      .then((ids) => {
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const { tabId, sessionId } of pairs) {
          const agentSessionId = ids[sessionId];
          if (agentSessionId) next.set(agentSessionId, tabId);
        }
        setTabs(next);
      })
      .catch((err: unknown) => {
        frontendLog("agent_node", `open-tab sessions of ${agentId}: ${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, key, refreshKey]);

  return tabs;
}

/**
 * Bring `tabId` to the front: switch to its tab group when needed and focus it
 * in its panel (#5960). Returns false when the tab is gone.
 */
export function focusTabAnywhere(tabId: string): boolean {
  const state = useAppStore.getState();
  const layout = getComposedLayout(state);
  const active = findLeafByTab(layout.rootPanel, tabId);
  if (active) {
    state.setActiveTab(tabId, active.id);
    return true;
  }
  for (const group of layout.tabGroups) {
    const leaf = findLeafByTab(group.rootPanel, tabId);
    if (!leaf) continue;
    state.setActiveTabGroup(group.id);
    useAppStore.getState().setActiveTab(tabId, leaf.id);
    return true;
  }
  return false;
}
