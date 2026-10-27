import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AgentDefinitionInfo } from "@/types/generated/AgentDefinitionInfo";
import {
  currentAgentsView,
  ensureAgentsSubscribed,
  logAgentBridgeFallback,
  onAgentsView,
} from "@/store/agentsBridge";

/** Subscribe adapter: `onAgentsView` passes the view, the store ignores it. */
function subscribe(onChange: () => void): () => void {
  return onAgentsView(() => onChange());
}

/**
 * The saved definition `definitionId` on agent `agentId` from the
 * authoritative `agents` region, or `undefined` when either id is unset or the
 * definition is not (or no longer) known. Used where only the ids are at hand —
 * e.g. a tab rendering its agent definition's icon colour and emoji (#5021).
 * Re-renders only when that definition's object changes.
 */
export function useAgentDefinition(
  agentId: string | undefined,
  definitionId: string | undefined
): AgentDefinitionInfo | undefined {
  useEffect(() => {
    if (!agentId || !definitionId) return;
    // The sidebar normally holds the subscription; make sure a tab on its own
    // (e.g. in a detached window) still receives the region.
    try {
      ensureAgentsSubscribed().catch((err) => logAgentBridgeFallback("subscribe", err));
    } catch (err) {
      logAgentBridgeFallback("subscribe", err);
    }
  }, [agentId, definitionId]);
  const getSnapshot = useCallback(
    () =>
      agentId && definitionId
        ? currentAgentsView().agentDefinitions[agentId]?.find((d) => d.id === definitionId)
        : undefined,
    [agentId, definitionId]
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}
