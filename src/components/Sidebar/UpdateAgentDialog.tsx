import React from "react";
import { AlertCircle, ArrowUp } from "lucide-react";
import { ConfirmDialog, toast } from "@/components/ui";
import { formatRelativeTime } from "@/utils/formatters";
import { frontendLog } from "@/utils/frontendLog";
import {
  updateAgent,
  updateAgentForce,
  type AgentDeployConfig,
  type AgentDeployResult,
  type ConnectedHost,
} from "@/services/api";
import type { RemoteAgentConfig } from "@/types/terminal";
import "./UpdateAgentDialog.css";

/** Props for {@link UpdateAgentDialog}. */
export interface UpdateAgentDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** Called with the next open state (Cancel, close, ESC, or a successful update). */
  onOpenChange: (open: boolean) => void;
  /** Agent id the update targets. */
  agentId: string;
  /** Agent display name, shown in the dialog title. */
  agentName: string;
  /** SSH/agent connection config forwarded to the update command. */
  config: RemoteAgentConfig;
  /** Deploy config (remote path override). Defaults to `{}`. */
  deployConfig?: AgentDeployConfig;
  /** Currently installed agent version, or `null` if unknown. */
  installedVersion: string | null;
  /** Version the update would install. */
  availableVersion: string;
  /**
   * Hosts (other than this desktop) connected to the agent, from the
   * connected-host guard / `agent.list_connections`. When non-empty the dialog
   * shows the warning and the primary action forces the update (#1349).
   */
  otherHosts: ConnectedHost[];
  /** Called with the deploy result after a successful update. */
  onUpdated?: (result: AgentDeployResult) => void;
}

/**
 * Update Prompt dialog (concept `remote-agent-update-strategy`, dialogs mockup
 * state 1). Shows installed vs. available versions and — when other hosts are
 * connected to the agent — an amber warning listing them. Updating does not cut
 * those hosts off: each runs its own agent worker, which keeps running until
 * that host reconnects, and their sessions survive either way (#4037). With
 * other hosts the update is forced ({@link updateAgentForce}), and the action
 * reads "Notify Others & Update" when the coordinated strategy will send them a
 * notice; with none it is a plain "Update" ({@link updateAgent}). Both actions
 * use the async Button lifecycle and surface success/failure feedback.
 */
export function UpdateAgentDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  config,
  deployConfig,
  installedVersion,
  availableVersion,
  otherHosts,
  onUpdated,
}: UpdateAgentDialogProps): React.ReactElement {
  const hasOtherHosts = otherHosts.length > 0;
  // Only the coordinated strategy sends other hosts a notice (#1616); the
  // immediate path updates without one (#4037).
  const notifiesOthers = hasOtherHosts && config.updateStrategy === "coordinated";

  const handleConfirm = async (): Promise<void> => {
    frontendLog(
      "agent_update",
      `update ${agentId} (force=${hasOtherHosts}, otherHosts=${otherHosts.length})`
    );
    const effectiveDeployConfig = deployConfig ?? {};
    const result = hasOtherHosts
      ? await updateAgentForce(agentId, config, effectiveDeployConfig)
      : await updateAgent(agentId, config, effectiveDeployConfig);

    // The plain path can still report other hosts if any connected after the
    // dialog opened — keep the dialog open and let the user retry (forced).
    if (result.kind === "otherHostsConnected") {
      onUpdated?.(result);
      throw new Error(
        `${result.hosts.length} other host(s) are connected — confirm again to force the update`
      );
    }

    // A coordinated-strategy update (#1616) was staged and dispatched: the agent
    // notified the other hosts and either applied now (idle) or deferred until
    // its last session disconnects.
    if (result.kind === "coordinated") {
      const n = result.notifiedClients;
      if (result.applied) {
        toast.success(
          n > 0
            ? `Updating agent on ${agentName} — ${n} other host${n === 1 ? "" : "s"} notified. Reconnecting…`
            : `Updating agent on ${agentName} — reconnecting…`
        );
      } else {
        const s = result.activeSessions;
        toast.info(
          `Update deferred on ${agentName} — it will apply automatically when the last of ` +
            `${s} active session${s === 1 ? "" : "s"} disconnects.`
        );
      }
      onUpdated?.(result);
      onOpenChange(false);
      return;
    }

    toast.success(`Updating agent on ${agentName}…`);
    onUpdated?.(result);
    onOpenChange(false);
  };

  return (
    <ConfirmDialog
      open={open}
      title={`Update agent on ${agentName}`}
      description={`Update the termiHub agent on ${agentName}`}
      data-testid="update-agent-dialog"
      testIdBase="update-agent"
      confirmVariant="primary"
      confirmIcon={<ArrowUp size={13} aria-hidden="true" />}
      confirmLabel={notifiesOthers ? "Notify Others & Update" : "Update"}
      onConfirm={handleConfirm}
      onCancel={() => onOpenChange(false)}
    >
      <div className="update-agent-dialog__versions">
        <div className="update-agent-dialog__ver-line">
          <span className="update-agent-dialog__ver-label">Installed</span>
          <span className="update-agent-dialog__ver-value">
            {installedVersion ? `v${installedVersion}` : "unknown"}
          </span>
        </div>
        <div className="update-agent-dialog__ver-line">
          <span className="update-agent-dialog__ver-label">Available</span>
          <span className="update-agent-dialog__ver-value">v{availableVersion}</span>
        </div>
      </div>

      {hasOtherHosts ? (
        <div className="update-agent-dialog__warning" data-testid="update-agent-other-hosts">
          <AlertCircle className="update-agent-dialog__warning-icon" size={16} aria-hidden="true" />
          <div>
            {otherHosts.length} other host(s) are connected to this agent:
            <ul className="update-agent-dialog__hosts">
              {otherHosts.map((host) => (
                <li key={host.clientId}>
                  {host.client}{" "}
                  <span className="update-agent-dialog__host-time">
                    — connected {formatRelativeTime(host.connectedSince)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="update-agent-dialog__warning-hint">
              Their sessions keep running. They switch to the new version when they reconnect.
            </div>
          </div>
        </div>
      ) : (
        <p className="update-agent-dialog__note">
          No other hosts are connected. The update applies immediately.
        </p>
      )}
    </ConfirmDialog>
  );
}
