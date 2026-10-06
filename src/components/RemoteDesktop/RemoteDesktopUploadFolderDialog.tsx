import { useCallback, useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { Modal, Button, Field, Input } from "@/components/ui";
import { isImeComposing } from "@/utils/imeComposition";

interface RemoteDesktopUploadFolderDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** The file host the folder lives on (named in the label). */
  host: string;
  /** The pre-filled folder: the session's current upload folder. */
  defaultDir: string;
  /** Confirm with the chosen (trimmed, non-empty) folder. */
  onSubmit: (dir: string) => void;
  /** Dismiss without uploading. */
  onCancel: () => void;
}

/**
 * "Upload to folder…" of the remote-desktop Files popover (#4192): choose the
 * folder on the side-channel host (`~/…` is the account's home), then pick the
 * local files. The backend checks the folder exists before anything moves; the
 * choice is remembered for the session once an upload into it starts.
 */
export function RemoteDesktopUploadFolderDialog({
  open,
  host,
  defaultDir,
  onSubmit,
  onCancel,
}: RemoteDesktopUploadFolderDialogProps) {
  const [dir, setDir] = useState(defaultDir);

  useEffect(() => {
    if (open) setDir(defaultDir);
  }, [open, defaultDir]);

  const trimmed = dir.trim();

  const handleSubmit = useCallback(() => {
    if (trimmed) onSubmit(trimmed);
  }, [trimmed, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeComposing(e)) return;
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
      title="Upload to folder"
      description={`Files are uploaded to this folder on ${host}. Name clashes keep both files.`}
      onKeyDown={handleKeyDown}
      data-testid="remote-desktop-upload-folder-dialog"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel}
            data-testid="remote-desktop-upload-folder-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Upload size={14} />}
            onClick={handleSubmit}
            disabled={!trimmed}
            data-testid="remote-desktop-upload-folder-submit"
          >
            Choose files…
          </Button>
        </>
      }
    >
      <Field
        label={`Folder on ${host}`}
        htmlFor="remote-desktop-upload-folder"
        hint="~ is your home folder"
      >
        <Input
          id="remote-desktop-upload-folder"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="~/Desktop"
          autoFocus
          data-testid="remote-desktop-upload-folder-input"
        />
      </Field>
    </Modal>
  );
}
