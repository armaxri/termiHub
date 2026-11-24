import { onAgentSetupProgress } from "@/services/events";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";
import { useTauriSubscription } from "./useTauriListener";

/**
 * Hook that folds backend `agent-setup-progress` events into the per-agent
 * setup phase (#5906), app-wide, so an agent row keeps saying "Installing…"
 * and then "Connect" even after the setup wizard was closed mid-run.
 */
export function useAgentSetupProgressEvents(): void {
  const applyProgress = useAgentSetupStatus((s) => s.applyProgress);

  useTauriSubscription(
    onAgentSetupProgress,
    (agentId: string, step: string) => applyProgress(agentId, step),
    "agent_setup"
  );
}
