import { useEffect, useState } from "react";
import { Modal, Button, Input } from "@/components/ui";
import type { FileEntry } from "@/types/connection";

interface SymlinkDialogProps {
  /** The entry the new link will point at, or `null` when closed. */
  entry: FileEntry | null;
  /**
   * Create a symlink named `linkName` in the current directory pointing at the
   * entry. Rejects surface as a toast in the caller (which re-throws so the
   * dialog stays open).
   */
  onApply: (entry: FileEntry, linkName: string) => Promise<void>;
  /** Close the dialog without creating anything. */
  onClose: () => void;
}

/**
 * A small "create symbolic link" editor: the selected entry is the link target
 * and the user names the new link, created in the current directory. Only
 * offered by backends that support symlink creation (SFTP-backed sessions or a
 * local Unix host).
 */
export function SymlinkDialog({ entry, onApply, onClose }: SymlinkDialogProps) {
  const [linkName, setLinkName] = useState("");

  // Re-seed (clear) whenever the target entry changes (a new dialog open).
  useEffect(() => {
    setLinkName("");
  }, [entry]);

  const trimmed = linkName.trim();
  // The link is created in the current directory, so a name may not be empty,
  // contain a path separator, or be a directory-relative token.
  const invalid = trimmed === "" || trimmed.includes("/") || trimmed === "." || trimmed === "..";

  // Returned promise drives the Create button's async pending lifecycle. Errors
  // propagate so the caller's `onApply` surfaces the toast and the dialog stays
  // open; on success the dialog closes.
  const handleApply = async () => {
    if (!entry || invalid) return;
    await onApply(entry, trimmed);
    onClose();
  };

  return (
    <Modal
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Create Symlink"
      description={entry ? `Create a symbolic link pointing at ${entry.name}` : undefined}
      data-testid="symlink-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="symlink-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleApply}
            disabled={invalid}
            errorToast={false}
            data-testid="symlink-create"
          >
            Create
          </Button>
        </>
      }
    >
      <div className="symlink-dialog">
        <p className="symlink-dialog__target" title={entry?.path}>
          Target: {entry?.path}
        </p>
        <div className="symlink-dialog__field">
          <label htmlFor="symlink-name">Link name</label>
          <Input
            id="symlink-name"
            size="sm"
            value={linkName}
            spellCheck={false}
            placeholder="new-link-name"
            onChange={(e) => setLinkName(e.target.value)}
            data-testid="symlink-name"
            aria-label="Link name"
          />
        </div>
      </div>
    </Modal>
  );
}
