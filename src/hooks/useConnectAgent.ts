import { useCallback } from "react";
import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { classifyAgentError } from "@/utils/classifyAgentError";
import { connectAgentWithCredentials } from "@/utils/connectAgent";

/**
 * "Connect agent" away from the agent's own row (#6063): asks for what it needs
 * and says why it failed. What waits for the agent goes on by itself.
 */
export function useConnectAgent(): (agentId: string) => Promise<void> {
  const { remoteAgents } = useProjectedAgents();
  const requestPassword = useAppStore((s) => s.requestPassword);
  const connectRemoteAgent = useAppStore((s) => s.connectRemoteAgent);
  return useCallback(
    async (agentId) => {
      const agent = remoteAgents.find((a) => a.id === agentId);
      if (!agent) return;
      try {
        await connectAgentWithCredentials(agent, { requestPassword, connectRemoteAgent });
      } catch (err) {
        // The agent's own row is in another sidebar view.
        // toast-policy: no-in-place-surface
        toast.error(`Failed to connect ${agent.name}`, {
          description: classifyAgentError(err).message,
        });
      }
    },
    [remoteAgents, requestPassword, connectRemoteAgent]
  );
}
