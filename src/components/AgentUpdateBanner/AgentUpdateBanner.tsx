import { useCallback } from "react";
import { ArrowUpCircle } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { Button, toast } from "@/components/ui";
import { requestAgentDeferredUpdate, requestAgentUpdate } from "@/services/api";
import { awaitExpectedApplyDisconnect } from "./expectedApplyDisconnect";
import "./AgentUpdateBanner.css";

/** Props for {@link AgentUpdateBanner}. */
export interface AgentUpdateBannerProps {
  /** Id of the agent this banner belongs to. */
  agentId: string;
  /** Display name of the agent, shown in the banner copy. */
  agentName: string;
}

/**
 * Per-agent banner offering to apply a staged deferred update (#1352). Shown
 * near a connected agent's header when the agent has reported a staged update
 * (`agent.update_available`, `staged: true`) that the user has not dismissed.
 *
 * "Apply Now" requests the deferred update: when the agent is idle it swaps
 * immediately (`applied: true`); otherwise it defers until the last active
 * session disconnects (`applied: false`, `activeSessions: N`). The staged
 * binary is applied automatically on that last disconnect regardless — the
 * banner just lets the user trigger it sooner. Every outcome resolves with a
 * toast; a post-apply connection drop is treated as expected.
 */
export function AgentUpdateBanner({ agentId, agentName }: AgentUpdateBannerProps) {
  const update = useAppStore((s) => s.agentUpdates[agentId]);
  const dismissed = useAppStore((s) => s.agentUpdatesDismissed[agentId] ?? false);
  const dismissAgentUpdate = useAppStore((s) => s.dismissAgentUpdate);
  // A coordinated-strategy agent stages its self-update and waits for a
  // coordinated apply (#1351): "Apply Now" must go through `agent.request_update`
  // so every *other* connected host is warned and given a clean disconnect
  // window, rather than hard-cut by the plain deferred apply (#1602).
  const { remoteAgents } = useProjectedAgents();
  const isCoordinated =
    remoteAgents.find((a) => a.id === agentId)?.config.updateStrategy === "coordinated";

  const handleApply = useCallback(async () => {
    try {
      if (isCoordinated) {
        const result = await requestAgentUpdate(agentId);
        if (result.applied) {
          const n = result.notifiedClients;
          toast.success(
            n > 0
              ? `Agent updating — ${n} other host${n === 1 ? "" : "s"} notified. Reconnecting…`
              : "Agent updated — reconnecting…"
          );
        } else {
          const n = result.activeSessions;
          toast.info(
            `Update deferred — it will be applied automatically when the last of ${n} active ` +
              `session${n === 1 ? "" : "s"} disconnects.`
          );
        }
        dismissAgentUpdate(agentId);
        return;
      }
      const result = await requestAgentDeferredUpdate(agentId);
      if (result.applied) {
        toast.success("Agent updated — reconnecting…");
      } else {
        const n = result.activeSessions;
        toast.info(
          `Update deferred — it will be applied automatically when the last of ${n} active ` +
            `session${n === 1 ? "" : "s"} disconnects.`
        );
      }
      dismissAgentUpdate(agentId);
    } catch (err) {
      // An immediate apply re-execs the agent, tearing down its transport — so a
      // failure here is expected *only if the agent's connection actually drops*.
      // Decide from the agent's authoritative connection state (a transport drop
      // within a short window after the apply request), not by parsing the error
      // message: message parsing was locale-fragile and over-broad (I18N-008). If
      // the connection stays up, this was a real update failure — surface it.
      if (await awaitExpectedApplyDisconnect(agentId)) {
        toast.info("Agent is updating — it will reconnect automatically once the swap completes.");
        dismissAgentUpdate(agentId);
        return;
      }
      // Genuine failure: rethrow so the async Button surfaces a recoverable
      // error toast and returns to idle.
      throw err;
    }
  }, [agentId, dismissAgentUpdate, isCoordinated]);

  const handleDismiss = useCallback(() => {
    dismissAgentUpdate(agentId);
  }, [agentId, dismissAgentUpdate]);

  // Only surface a staged, undismissed update.
  if (!update || !update.staged || dismissed) {
    return null;
  }

  return (
    <div className="agent-update-banner" data-testid={`agent-update-banner-${agentId}`}>
      <span className="agent-update-banner__icon">
        <ArrowUpCircle size={16} />
      </span>
      <div className="agent-update-banner__text">
        <strong>
          {agentName}: update available (v{update.availableVersion})
        </strong>
        <span>It will be applied automatically when the last session disconnects.</span>
      </div>
      <div className="agent-update-banner__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          data-testid={`agent-update-banner-dismiss-${agentId}`}
        >
          Dismiss
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleApply}
          data-testid={`agent-update-banner-apply-${agentId}`}
        >
          Apply Now
        </Button>
      </div>
    </div>
  );
}
