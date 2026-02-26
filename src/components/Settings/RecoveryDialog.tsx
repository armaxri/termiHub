/**
 * Dialog shown at startup when corrupt config files were recovered.
 *
 * Lists the recovery actions taken (reset, dropped entries, etc.) and
 * provides expandable technical details for each warning.
 */

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle } from "lucide-react";
import { RecoveryWarning } from "@/types/connection";
import "./RecoveryDialog.css";

interface RecoveryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warnings: RecoveryWarning[];
}

export function RecoveryDialog({ open, onOpenChange, warnings }: RecoveryDialogProps) {
  if (warnings.length === 0) return null;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="recovery-dialog__overlay" />
        <Dialog.Content className="recovery-dialog__content" data-testid="recovery-dialog">
          <div className="recovery-dialog__icon-row">
            <AlertTriangle size={20} className="recovery-dialog__icon" />
            <Dialog.Title className="recovery-dialog__title">Configuration Recovery</Dialog.Title>
          </div>
          <Dialog.Description className="recovery-dialog__description">
            Some configuration files were corrupt and have been repaired. A backup of the original
            files has been saved.
          </Dialog.Description>
          <ul className="recovery-dialog__warnings">
            {warnings.map((warning, i) => (
              <li key={i} className="recovery-dialog__warning">
                <span className="recovery-dialog__file-name">{warning.fileName}</span>
                <span className="recovery-dialog__message">{warning.message}</span>
                {warning.details && (
                  <details className="recovery-dialog__details">
                    <summary>Technical details</summary>
                    <code className="recovery-dialog__raw">{warning.details}</code>
                  </details>
                )}
              </li>
            ))}
          </ul>
          <div className="recovery-dialog__actions">
            <button
              className="recovery-dialog__btn recovery-dialog__btn--primary"
              onClick={() => onOpenChange(false)}
              data-testid="recovery-dialog-close"
            >
              OK
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
