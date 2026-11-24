import { onAgentSetupProgress } from "@/services/events";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";
import { useTauriSubscription } from "./useTauriListener";

/**
 * Hook that folds backend `agent-setup-progress` events into the per-agent
 * setup phase (#5906), app-wide, so an agent row keeps saying "Installing…"
 * and then "Connect" even after the setup wizard was closed mid-run, and the
 * setup tab says when the run failed or was cancelled (#5865).
 */
export function useAgentSetupProgressEvents(): void {
  const applyProgress = useAgentSetupStatus((s) => s.applyProgress);

  useTauriSubscription(
    onAgentSetupProgress,
    (agentId: string, step: string, message: string) => applyProgress(agentId, step, message),
    "agent_setup"
  );
}
