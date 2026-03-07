import * as Dialog from "@radix-ui/react-dialog";

interface LargePasteDialogProps {
  open: boolean;
  charCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation dialog shown when pasting text larger than the threshold. */
export function LargePasteDialog({ open, charCount, onConfirm, onCancel }: LargePasteDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content
          className="large-paste-dialog"
          data-testid="large-paste-dialog"
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            width: "400px",
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
            Large Paste
          </Dialog.Title>
          <Dialog.Description style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>
            You are about to paste {charCount.toLocaleString()} characters into the terminal. Are
            you sure?
          </Dialog.Description>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              onClick={onCancel}
              data-testid="large-paste-cancel"
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
              data-testid="large-paste-confirm"
              style={{
                padding: "4px 16px",
                border: "none",
                borderRadius: "var(--radius-md, 4px)",
                background: "var(--accent-color)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Paste
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
