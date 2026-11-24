/**
 * Dialog that shows categorized connection error feedback for a remote agent.
 *
 * Displays a user-friendly message based on the error category. For
 * "agent-missing" errors, offers a "Set up agent" button to open the
 * AgentSetupDialog.
 *
 * A host without the agent yet is an expected first-run step, not a failure
 * (R-094/R-095, #5851): that dialog names the host, shows a neutral info icon
 * instead of the red warning triangle, and starts focused on "Set up agent".
 */

import { useRef } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { ClassifiedAgentError } from "@/utils/classifyAgentError";
import "./ConnectionErrorDialog.css";

interface ConnectionErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error: ClassifiedAgentError | null;
  onSetupAgent?: () => void;
  onForceReconnect?: () => void;
  /** The agent's host, named in the "not installed" dialog (#5851). */
  host?: string;
}

/** Title and message of the "agent not installed" dialog for `host` (#5851). */
export function agentMissingCopy(host: string): { title: string; message: string } {
  return {
    title: `Agent not installed on ${host}`,
    message:
      `SSH reached ${host}, but the termiHub agent is not installed there yet. ` +
      "Set it up to connect: termiHub uploads it over SSH.",
  };
}

export function ConnectionErrorDialog({
  open,
  onOpenChange,
  error,
  onSetupAgent,
  onForceReconnect,
  host,
}: ConnectionErrorDialogProps) {
  const setupRef = useRef<HTMLButtonElement>(null);
  if (!error) return null;

  const notInstalled = error.category === "agent-missing";
  const copy = notInstalled && host ? agentMissingCopy(host) : error;
  const Icon = notInstalled ? Info : AlertTriangle;

  const showSetupAgent =
    (error.category === "agent-missing" || error.category === "agent-outdated") &&
    Boolean(onSetupAgent);
  const showForceReconnect = error.category === "already-connected" && Boolean(onForceReconnect);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      dismissTransientToasts
      initialFocusRef={showSetupAgent ? setupRef : undefined}
      title={
        <span className="connection-error-dialog__title-row">
          <Icon
            size={20}
            className={`connection-error-dialog__icon${notInstalled ? " connection-error-dialog__icon--info" : ""}`}
            aria-hidden="true"
            data-testid="connection-error-icon"
            data-icon={notInstalled ? "info" : "alert"}
          />
          <span data-testid="connection-error-title">{copy.title}</span>
        </span>
      }
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="connection-error-close"
          >
            Close
          </Button>
          {/* At most one primary action: the two categories never coincide. */}
          {showSetupAgent ? (
            <Button
              ref={setupRef}
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onSetupAgent?.();
              }}
              data-testid="connection-error-setup-agent"
            >
              Set up agent
            </Button>
          ) : showForceReconnect ? (
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onForceReconnect?.();
              }}
              data-testid="connection-error-force-reconnect"
            >
              Force reconnect
            </Button>
          ) : null}
        </>
      }
    >
      <p className="connection-error-dialog__message" data-testid="connection-error-message">
        {copy.message}
      </p>
      {error.rawError !== copy.message && (
        <details
          className="connection-error-dialog__details"
          data-testid="connection-error-details"
        >
          <summary>Technical details</summary>
          <code className="connection-error-dialog__raw">{error.rawError}</code>
        </details>
      )}
    </Modal>
  );
}
