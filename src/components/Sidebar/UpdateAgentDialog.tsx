import React from "react";
import { AlertCircle, ArrowUp } from "lucide-react";
import { Button, Modal, toast } from "@/components/ui";
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
 * connected to the agent — an amber warning listing them. With other hosts the
 * primary action is "Notify Others & Update" ({@link updateAgentForce}); with
 * none it is a plain "Update" ({@link updateAgent}). Both actions use the async
 * Button lifecycle and surface success/failure feedback.
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

    toast.success(`Updating agent on ${agentName}…`);
    onUpdated?.(result);
    onOpenChange(false);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Update agent on ${agentName}`}
      description={`Update the termiHub agent on ${agentName}`}
      data-testid="update-agent-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="update-agent-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<ArrowUp size={13} aria-hidden="true" />}
            onClick={handleConfirm}
            data-testid="update-agent-confirm"
          >
            {hasOtherHosts ? "Notify Others & Update" : "Update"}
          </Button>
        </>
      }
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
              They will receive a disconnect notice and reconnect automatically.
            </div>
          </div>
        </div>
      ) : (
        <p className="update-agent-dialog__note">
          No other hosts are connected. The update applies immediately.
        </p>
      )}
    </Modal>
  );
}
