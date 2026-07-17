import { useEffect } from "react";
import { useAppStore } from "@/store/appStore";
import { onRemoteAgentUpdatePending } from "@/services/events";

/**
 * Hook that bridges backend `remote-agent-update-pending` events (#1602) to the
 * store's coordinated-update handling. Each event is an agent's
 * `agent.update_pending` notification — broadcast when *another* host initiates
 * a coordinated update (#1351) — forwarded by the desktop backend. Handling it
 * shows the "being updated by another host" notice, suspends the affected agent
 * connection (the disconnect is the ack) and queues an auto-reconnect to the new
 * version.
 */
export function useAgentUpdatePendingEvents(): void {
  const handleAgentUpdatePending = useAppStore((s) => s.handleAgentUpdatePending);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      unlisten = await onRemoteAgentUpdatePending((pending) => {
        handleAgentUpdatePending(
          pending.agentId,
          pending.requestedByVersion,
          pending.estimatedRestartSecs
        );
      });
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, [handleAgentUpdatePending]);
}
