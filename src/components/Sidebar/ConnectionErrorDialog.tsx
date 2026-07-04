/**
 * Dialog that shows categorized connection error feedback for a remote agent.
 *
 * Displays a user-friendly message based on the error category. For
 * "agent-missing" errors, offers a "Setup Agent" button to open the
 * AgentSetupDialog.
 */

import { AlertTriangle } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { ClassifiedAgentError } from "@/utils/classifyAgentError";
import "./ConnectionErrorDialog.css";

interface ConnectionErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error: ClassifiedAgentError | null;
  onSetupAgent?: () => void;
  onForceReconnect?: () => void;
}

export function ConnectionErrorDialog({
  open,
  onOpenChange,
  error,
  onSetupAgent,
  onForceReconnect,
}: ConnectionErrorDialogProps) {
  if (!error) return null;

  const showSetupAgent =
    (error.category === "agent-missing" || error.category === "agent-outdated") &&
    Boolean(onSetupAgent);
  const showForceReconnect = error.category === "already-connected" && Boolean(onForceReconnect);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="connection-error-dialog__title-row">
          <AlertTriangle size={20} className="connection-error-dialog__icon" aria-hidden="true" />
          <span data-testid="connection-error-title">{error.title}</span>
        </span>
      }
      footer={
        <>
          {showSetupAgent && (
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onSetupAgent?.();
              }}
              data-testid="connection-error-setup-agent"
            >
              Setup Agent
            </Button>
          )}
          {showForceReconnect && (
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
                onForceReconnect?.();
              }}
              data-testid="connection-error-force-reconnect"
            >
              Force Reconnect
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="connection-error-close"
          >
            Close
          </Button>
        </>
      }
    >
      <p className="connection-error-dialog__message" data-testid="connection-error-message">
        {error.message}
      </p>
      {error.rawError !== error.message && (
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
