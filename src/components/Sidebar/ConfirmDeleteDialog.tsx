import { ConfirmDialog } from "@/components/ui";

interface ConfirmDeleteDialogProps {
  open: boolean;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Themed confirmation dialog for destructive delete actions in the file browser. */
export function ConfirmDeleteDialog({
  open,
  message,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      title="Confirm Delete"
      message={message}
      confirmLabel="Delete"
      confirmVariant="danger"
      testIdBase="confirm-delete"
      data-testid="confirm-delete-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
