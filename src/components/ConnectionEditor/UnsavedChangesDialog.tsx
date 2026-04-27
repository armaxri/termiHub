import * as Dialog from "@radix-ui/react-dialog";

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
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content
          className="unsaved-changes-dialog"
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
            Unsaved Changes
          </Dialog.Title>
          <Dialog.Description style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>
            This connection has unsaved changes. What would you like to do?
          </Dialog.Description>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              onClick={onCancel}
              data-testid="unsaved-changes-cancel"
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
              onClick={onJustClose}
              data-testid="unsaved-changes-just-close"
              style={{
                padding: "4px 16px",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md, 4px)",
                background: "transparent",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              Just Close
            </button>
            <button
              onClick={onSaveAndClose}
              data-testid="unsaved-changes-save-and-close"
              style={{
                padding: "4px 16px",
                border: "1px solid var(--border-primary)",
                borderRadius: "var(--radius-md, 4px)",
                background: "transparent",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
            >
              Save &amp; Close
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
