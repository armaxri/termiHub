/**
 * Dialog that shows categorized connection error feedback for a remote agent.
 *
 * Displays a user-friendly message based on the error category. For
 * "agent-missing" errors, offers a "Setup Agent" button to open the
 * AgentSetupDialog.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import { ClassifiedAgentError } from "@/utils/classifyAgentError";
import "./ConnectionErrorDialog.css";

interface ConnectionErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  error: ClassifiedAgentError | null;
  onSetupAgent?: () => void;
}

export function ConnectionErrorDialog({
  open,
  onOpenChange,
  error,
  onSetupAgent,
}: ConnectionErrorDialogProps) {
  if (!error) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="connection-error-dialog__overlay" />
        <Dialog.Content className="connection-error-dialog__content">
          <div className="connection-error-dialog__icon-row">
            <AlertTriangle size={20} className="connection-error-dialog__icon" />
            <Dialog.Title
              className="connection-error-dialog__title"
              data-testid="connection-error-title"
            >
              {error.title}
            </Dialog.Title>
          </div>
          <Dialog.Description
            className="connection-error-dialog__message"
            data-testid="connection-error-message"
          >
            {error.message}
          </Dialog.Description>
          {error.rawError !== error.message && (
            <details
              className="connection-error-dialog__details"
              data-testid="connection-error-details"
            >
              <summary>Technical details</summary>
              <code className="connection-error-dialog__raw">{error.rawError}</code>
            </details>
          )}
          <div className="connection-error-dialog__actions">
            {error.category === "agent-missing" && onSetupAgent && (
              <button
                className="connection-error-dialog__btn connection-error-dialog__btn--primary"
                onClick={() => {
                  onOpenChange(false);
                  onSetupAgent();
                }}
                data-testid="connection-error-setup-agent"
              >
                Setup Agent
              </button>
            )}
            <button
              className="connection-error-dialog__btn connection-error-dialog__btn--secondary"
              onClick={() => onOpenChange(false)}
              data-testid="connection-error-close"
            >
              Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
