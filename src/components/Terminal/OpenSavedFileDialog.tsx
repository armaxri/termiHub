import * as Dialog from "@radix-ui/react-dialog";

interface OpenSavedFileDialogProps {
  open: boolean;
  /** Absolute path of the file that was just saved. */
  filePath: string;
  /** Current value of the persisted "ask again" setting. */
  askAgain: boolean;
  /** Called when the user toggles the "Ask again" checkbox. */
  onAskAgainChange: (askAgain: boolean) => void;
  /** Called when the user chooses to open the file in an editor tab. */
  onOpen: () => void;
  /** Called when the user dismisses the dialog without opening the file. */
  onCancel: () => void;
}

/**
 * Confirmation dialog shown after saving terminal content to a file, offering
 * to open the saved file in a Monaco editor tab.
 */
export function OpenSavedFileDialog({
  open,
  filePath,
  askAgain,
  onAskAgainChange,
  onOpen,
  onCancel,
}: OpenSavedFileDialogProps) {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcuts-overlay__backdrop" />
        <Dialog.Content
          className="open-saved-file-dialog"
          data-testid="open-saved-file-dialog"
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
            Open Saved File in Tab
          </Dialog.Title>
          <Dialog.Description style={{ color: "var(--text-secondary)", marginBottom: "16px" }}>
            Saved to <strong>{fileName}</strong>. Open it in an editor tab?
          </Dialog.Description>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginBottom: "16px",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={askAgain}
              onChange={(e) => onAskAgainChange(e.target.checked)}
              data-testid="open-saved-file-ask-again"
            />
            Ask again
          </label>
          <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
            <button
              onClick={onCancel}
              data-testid="open-saved-file-cancel"
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
              onClick={onOpen}
              data-testid="open-saved-file-confirm"
              style={{
                padding: "4px 16px",
                border: "none",
                borderRadius: "var(--radius-md, 4px)",
                background: "var(--accent-color)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Open
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
