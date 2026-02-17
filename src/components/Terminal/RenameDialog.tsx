import { useState, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import "./RenameDialog.css";

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="rename-dialog__overlay" />
        <Dialog.Content className="rename-dialog__content">
          <Dialog.Title className="rename-dialog__title">Rename Tab</Dialog.Title>
          <input
            className="rename-dialog__input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoFocus
            data-testid="rename-dialog-input"
          />
          <div className="rename-dialog__actions">
            <button
              className="rename-dialog__btn rename-dialog__btn--secondary"
              onClick={() => onOpenChange(false)}
              data-testid="rename-dialog-cancel"
            >
              Cancel
            </button>
            <button
              className="rename-dialog__btn rename-dialog__btn--primary"
              onClick={handleSubmit}
              data-testid="rename-dialog-apply"
            >
              Rename
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
