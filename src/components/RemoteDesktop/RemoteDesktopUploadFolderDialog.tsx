import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowUp, Folder, Upload } from "lucide-react";
import { Modal, Button, Field, Input, Spinner } from "@/components/ui";
import { isImeComposing } from "@/utils/imeComposition";
import { errorMessage } from "@/utils/errorMessage";
import { parentDirPath } from "@/utils/fileDragMove";
import type { RemoteFolderListing } from "./browseRemoteFiles";

interface RemoteDesktopUploadFolderDialogProps {
  /** Whether the dialog is open (controlled). */
  open: boolean;
  /** The file host the folder lives on (named in the label). */
  host: string;
  /** The pre-filled folder: the session's current upload folder. */
  defaultDir: string;
  /** List a folder's sub-folders on the side channel (resolving `~`). */
  listFolders: (dir: string) => Promise<RemoteFolderListing>;
  /** Confirm with the chosen (trimmed, non-empty) folder. */
  onSubmit: (dir: string) => void;
  /** Dismiss without uploading. */
  onCancel: () => void;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; listing: RemoteFolderListing }
  | { status: "error"; message: string };

/**
 * "Upload to folder…" of the remote-desktop Files popover (#4192, picker
 * #4204): browse the side-channel host's folders (or type one; `~/…` is the
 * account's home), then pick the local files. The backend checks the folder
 * exists before anything moves; the choice is remembered for the session once
 * an upload into it starts.
 */
export function RemoteDesktopUploadFolderDialog({
  open,
  host,
  defaultDir,
  listFolders,
  onSubmit,
  onCancel,
}: RemoteDesktopUploadFolderDialogProps) {
  const [dir, setDir] = useState(defaultDir);
  const [list, setList] = useState<ListState>({ status: "loading" });
  const request = useRef(0);
  // The parent passes a fresh function each render; listing must not re-run.
  const listRef = useRef(listFolders);
  listRef.current = listFolders;

  const load = useCallback((target: string) => {
    const id = ++request.current;
    setList({ status: "loading" });
    listRef
      .current(target)
      .then((listing) => {
        if (id !== request.current) return;
        setDir(listing.path);
        setList({ status: "ready", listing });
      })
      .catch((err: unknown) => {
        if (id === request.current) setList({ status: "error", message: errorMessage(err) });
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    setDir(defaultDir);
    load(defaultDir);
  }, [open, defaultDir, load]);

  const trimmed = dir.trim();
  const current = list.status === "ready" ? list.listing.path : null;

  const handleSubmit = useCallback(() => {
    if (trimmed) onSubmit(trimmed);
  }, [trimmed, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isImeComposing(e) || e.key !== "Enter") return;
      e.preventDefault();
      // Enter on a typed folder that is not listed yet opens it first.
      if (trimmed && trimmed !== current) load(trimmed);
      else handleSubmit();
    },
    [trimmed, current, load, handleSubmit]
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Upload to folder"
      description={`Files are uploaded to this folder on ${host}. Name clashes keep both files.`}
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
        hint="Open a folder below, or type one (~ is your home folder)"
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
      <div className="rd-folder-picker" data-testid="remote-desktop-folder-picker">
        {list.status === "loading" && (
          <div className="rd-folder-picker__status">
            <Spinner size="sm" label={null} />
            <span>Listing folders…</span>
          </div>
        )}
        {list.status === "error" && (
          <div className="rd-folder-picker__status" role="alert">
            <AlertCircle size={14} aria-hidden />
            <span>{list.message}</span>
          </div>
        )}
        {list.status === "ready" && (
          <ul className="rd-folder-picker__list">
            {list.listing.path !== "/" && (
              <li>
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  icon={<ArrowUp size={14} />}
                  onClick={() => load(parentDirPath(list.listing.path))}
                  data-testid="remote-desktop-folder-picker-up"
                >
                  ..
                </Button>
              </li>
            )}
            {list.listing.folders.map((folder) => (
              <li key={folder.path}>
                <Button
                  variant="ghost"
                  size="sm"
                  fullWidth
                  icon={<Folder size={14} />}
                  onClick={() => load(folder.path)}
                  data-testid="remote-desktop-folder-picker-entry"
                >
                  {folder.name}
                </Button>
              </li>
            ))}
            {list.listing.folders.length === 0 && (
              <li className="rd-folder-picker__status">No sub-folders</li>
            )}
          </ul>
        )}
      </div>
    </Modal>
  );
}
