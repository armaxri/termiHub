import { useAppStore } from "@/store/appStore";
import { onAgentUpdateReconnect, onRemoteAgentUpdatePending } from "@/services/events";
import { useTauriSubscription } from "./useTauriListener";

/**
 * Hook that presents the backend's coordinated agent-update reconnect (#1602,
 * #4489). When another host updates an agent, the backend suspends the agent
 * and reconnects it once for every window; this window only shows its state:
 *
 * - `remote-agent-update-pending` — the "being updated by another host"
 *   waiting notice, with a Cancel;
 * - `agent-update-reconnect` — how the reconnect ended (reconnected, failed or
 *   cancelled with a manual Reconnect, or superseded by a newer action).
 *
 * No timer runs in the window, so nothing needs stopping on unmount.
 */
export function useAgentUpdatePendingEvents(): void {
  const handleAgentUpdatePending = useAppStore((s) => s.handleAgentUpdatePending);
  const handleAgentUpdateReconnect = useAppStore((s) => s.handleAgentUpdateReconnect);

  useTauriSubscription(
    onRemoteAgentUpdatePending,
    (pending) => {
      handleAgentUpdatePending(
        pending.agentId,
        pending.requestedByVersion,
        pending.estimatedRestartSecs
      );
    },
    "agent_update"
  );

  useTauriSubscription(onAgentUpdateReconnect, handleAgentUpdateReconnect, "agent_update");
}
