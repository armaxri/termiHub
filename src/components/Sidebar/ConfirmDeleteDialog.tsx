import { ConfirmDialog } from "@/components/ui";
import type { ConfirmDontAskAgain } from "@/components/ui";

interface ConfirmDeleteDialogProps {
  open: boolean;
  /** What is deleted, as a question. */
  title?: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional "don't ask again" opt-out (only for deletes that can be undone). */
  dontAskAgain?: ConfirmDontAskAgain;
}

/** Themed confirmation dialog for destructive delete actions. */
export function ConfirmDeleteDialog({
  open,
  title = "Confirm delete",
  message,
  onConfirm,
  onCancel,
  dontAskAgain,
}: ConfirmDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title={title}
      variant="danger"
      message={message}
      confirmLabel="Delete"
      confirmVariant="danger"
      testIdBase="confirm-delete"
      data-testid="confirm-delete-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
      dontAskAgain={dontAskAgain}
    />
  );
}
