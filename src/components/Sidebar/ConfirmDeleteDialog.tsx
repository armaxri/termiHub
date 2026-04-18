import * as Dialog from "@radix-ui/react-dialog";

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
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content
          className="confirm-delete-dialog"
          data-testid="confirm-delete-dialog"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "380px",
            padding: "var(--spacing-lg, 16px)",
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border-primary)",
            borderRadius: "var(--radius-lg, 8px)",
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.3)",
            zIndex: 1001,
          }}
        >
          <Dialog.Title
            style={{ margin: "0 0 var(--spacing-md, 12px) 0", color: "var(--text-primary)" }}
          >
            Confirm Delete
          </Dialog.Title>
          <Dialog.Description style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>
            {message}
          </Dialog.Description>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              onClick={onCancel}
              data-testid="confirm-delete-cancel"
              style={{
                padding: "4px 16px",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md, 4px)",
                background: "transparent",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              data-testid="confirm-delete-confirm"
              style={{
                padding: "4px 16px",
                border: "none",
                borderRadius: "var(--radius-md, 4px)",
                background: "var(--color-error)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Delete
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
