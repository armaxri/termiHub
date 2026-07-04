import { Modal, Button } from "@/components/ui";

interface UnsavedChangesDialogProps {
  open: boolean;
  onCancel: () => void;
  onJustClose: () => void;
  onSaveAndClose: () => void;
}

/** Dialog shown when closing a tab with unsaved changes. */
export function UnsavedChangesDialog({
  open,
  onCancel,
  onJustClose,
  onSaveAndClose,
}: UnsavedChangesDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Unsaved Changes"
      description="This connection has unsaved changes. What would you like to do?"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="unsaved-changes-cancel">
            Cancel
          </Button>
          <Button variant="danger" onClick={onJustClose} data-testid="unsaved-changes-just-close">
            Just Close
          </Button>
          <Button
            variant="primary"
            onClick={onSaveAndClose}
            data-testid="unsaved-changes-save-and-close"
          >
            Save &amp; Close
          </Button>
        </>
      }
    >
      This connection has unsaved changes. What would you like to do?
    </Modal>
  );
}
