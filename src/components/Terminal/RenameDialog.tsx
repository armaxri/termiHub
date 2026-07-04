import { useState, useEffect } from "react";
import { Modal, Button, Input } from "@/components/ui";

interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTitle: string;
  onRename: (newTitle: string) => void;
}

/**
 * Dialog for renaming a terminal tab.
 */
export function RenameDialog({ open, onOpenChange, currentTitle, onRename }: RenameDialogProps) {
  const [title, setTitle] = useState(currentTitle);

  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
    }
  }, [open, currentTitle]);

  const handleSubmit = () => {
    const trimmed = title.trim();
    if (trimmed) {
      onRename(trimmed);
      onOpenChange(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Rename Tab"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            data-testid="rename-dialog-cancel"
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSubmit} data-testid="rename-dialog-apply">
            Rename
          </Button>
        </>
      }
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
        }}
        autoFocus
        data-testid="rename-dialog-input"
      />
    </Modal>
  );
}
