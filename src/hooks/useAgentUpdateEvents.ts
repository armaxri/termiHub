import { useAppStore } from "@/store/appStore";
import { onAgentUpdateAvailable } from "@/services/events";
import { useTauriSubscription } from "./useTauriListener";

/**
 * Hook that folds backend `agent-update-available` events (#1352) into the
 * store's `agentUpdates` map. Each event is an agent's `agent.update_available`
 * notification forwarded by the desktop backend; recording it lets the
 * per-agent deferred-update banner offer "Apply Now".
 */
export function useAgentUpdateEvents(): void {
  const setAgentUpdateAvailable = useAppStore((s) => s.setAgentUpdateAvailable);

  useTauriSubscription(
    onAgentUpdateAvailable,
    (update) => {
      setAgentUpdateAvailable(update.agentId, {
        currentVersion: update.currentVersion,
        availableVersion: update.availableVersion,
        staged: update.staged,
      });
    },
    "agent_update"
  );
}
