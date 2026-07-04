import { Modal, Button } from "@/components/ui";
import "./OpenSavedFileDialog.css";

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
    <Modal
      open={open}
      onOpenChange={(isOpen) => !isOpen && onCancel()}
      title="Open Saved File in Tab"
      data-testid="open-saved-file-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="open-saved-file-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={onOpen} data-testid="open-saved-file-confirm">
            Open
          </Button>
        </>
      }
    >
      <p className="open-saved-file__message">
        Saved to <strong>{fileName}</strong>. Open it in an editor tab?
      </p>
      <label className="open-saved-file__ask-again">
        <input
          type="checkbox"
          checked={askAgain}
          onChange={(e) => onAskAgainChange(e.target.checked)}
          data-testid="open-saved-file-ask-again"
        />
        Ask again
      </label>
    </Modal>
  );
}
