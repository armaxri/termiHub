import { Modal, Button } from "@/components/ui";

interface LargePasteDialogProps {
  open: boolean;
  charCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation dialog shown when pasting text larger than the threshold. */
export function LargePasteDialog({ open, charCount, onConfirm, onCancel }: LargePasteDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Large Paste"
      data-testid="large-paste-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="large-paste-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} data-testid="large-paste-confirm">
            Paste
          </Button>
        </>
      }
    >
      You are about to paste {charCount.toLocaleString()} characters into the terminal. Are you
      sure?
    </Modal>
  );
}
