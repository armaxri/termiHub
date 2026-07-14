import { useState, useEffect, useCallback } from "react";
import { Copy } from "lucide-react";
import { Modal, Button, Field, Input } from "@/components/ui";

export interface SaveCopyDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /**
   * Suggested initial remote path. The user edits it to point at a writable
   * location — the original file is read-only, so saving over it would fail.
   */
  defaultPath: string;
  /** True while the parent writes the copy (drives the pending state). */
  busy?: boolean;
  /** Confirm with the chosen (trimmed, non-empty) remote path. */
  onSubmit: (remotePath: string) => void;
  /** Cancel / dismiss without saving. */
  onCancel: () => void;
}

/**
 * Prompt for the destination of a "Save a copy" of a read-only remote file
 * (#1330). Used when the connection has no exec channel (SFTP-only / relayed),
 * so a privilege-elevated save is impossible and the user instead writes the
 * current buffer to a writable path on the remote host.
 *
 * Composed entirely from shared UI primitives (Modal / Field / Input / Button);
 * the chosen path is handed straight back via {@link onSubmit}.
 */
export function SaveCopyDialog({
  open,
  defaultPath,
  busy = false,
  onSubmit,
  onCancel,
}: SaveCopyDialogProps) {
  const [path, setPath] = useState(defaultPath);

  // Reset the field to the suggested path whenever the dialog (re)opens.
  useEffect(() => {
    if (open) setPath(defaultPath);
  }, [open, defaultPath]);

  const trimmed = path.trim();

  const handleSubmit = useCallback(() => {
    if (!trimmed || busy) return;
    onSubmit(trimmed);
  }, [trimmed, busy, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit]
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Save a copy"
      description="This file is read-only. Write the current contents to a writable path on the remote host."
      onKeyDown={handleKeyDown}
      data-testid="save-copy-dialog"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="save-copy-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Copy size={14} />}
            onClick={handleSubmit}
            disabled={!trimmed || busy}
            data-testid="save-copy-submit"
          >
            {busy ? "Saving…" : "Save a copy"}
          </Button>
        </>
      }
    >
      <Field label="Destination path" htmlFor="save-copy-path">
        <Input
          id="save-copy-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="/writable/path/to/copy"
          autoFocus
          disabled={busy}
          data-testid="save-copy-input"
        />
      </Field>
    </Modal>
  );
}
