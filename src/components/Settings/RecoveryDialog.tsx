/**
 * Dialog shown at startup when corrupt config files were recovered.
 *
 * Lists the recovery actions taken (reset, dropped entries, etc.) and
 * provides expandable technical details for each warning.
 */

import { AlertTriangle } from "lucide-react";
import { Modal, Button } from "@/components/ui";
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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      data-testid="recovery-dialog"
      title={
        <span className="recovery-dialog__title-row">
          <AlertTriangle size={20} className="recovery-dialog__icon" />
          Configuration Recovery
        </span>
      }
      footer={
        <Button
          variant="primary"
          onClick={() => onOpenChange(false)}
          data-testid="recovery-dialog-close"
        >
          OK
        </Button>
      }
    >
      <div className="recovery-dialog__body">
        <p className="recovery-dialog__description">
          Some configuration files were corrupt and have been repaired. A backup of the original
          files has been saved.
        </p>
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
      </div>
    </Modal>
  );
}
