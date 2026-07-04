import { Modal, Button } from "@/components/ui";

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
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Confirm Delete"
      data-testid="confirm-delete-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="confirm-delete-cancel">
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} data-testid="confirm-delete-confirm">
            Delete
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  );
}
