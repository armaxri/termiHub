import { onAgentSetupProgress } from "@/services/events";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";
import { toast } from "@/components/ui";
import { useTauriSubscription } from "./useTauriListener";

/**
 * The steps that report a setup's outcome after its dialog closed: a checked
 * Windows setup's (#5992), and a POSIX setup's `done` once its shell ended and
 * its path is stored (#5518).
 */
function reportOutcome(step: string, message: string, agentName: string): void {
  if (step === "installed" || step === "done") {
    // toast-policy: background — checked on the host after the setup dialog closed
    toast.success(`Agent installed on ${agentName}`);
  } else if (step === "failed") {
    toast.error(`Agent setup on ${agentName} failed: ${message}`);
  } else if (step === "unknown") {
    // toast-policy: background — checked on the host after the setup dialog closed
    toast.info(`Agent setup on ${agentName}: outcome unknown. ${message}`);
  }
}

/**
 * Hook that folds backend `agent-setup-progress` events into the per-agent
 * setup phase (#5906), app-wide, so an agent row keeps saying "Installing…"
 * and then "Connect" even after the setup wizard was closed mid-run, and the
 * setup tab says when the run failed or was cancelled (#5865). A Windows
 * setup's outcome arrives after its wizard closed, so it is announced here
 * (#5992).
 */
export function useAgentSetupProgressEvents(): void {
  const applyProgress = useAgentSetupStatus((s) => s.applyProgress);

  useTauriSubscription(
    onAgentSetupProgress,
    (agentId: string, step: string, message: string, sessionId?: string | null) => {
      applyProgress(agentId, step, message, sessionId);
      const tab = Object.values(useAgentSetupStatus.getState().tabs).find(
        (t) => t.agentId === agentId && t.sessionId === sessionId
      );
      if (tab) reportOutcome(step, message, tab.agentName);
    },
    "agent_setup"
  );
}
