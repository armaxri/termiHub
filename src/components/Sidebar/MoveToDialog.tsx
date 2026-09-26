import { useEffect, useState } from "react";
import { Modal, Button, Input } from "@/components/ui";
import type { FileEntry } from "@/types/connection";
import { describeEntries, type FileTransferOperation } from "@/utils/fileDragMove";

/** What the dialog is moving/copying, or `null` when closed. */
export interface MoveToRequest {
  entries: FileEntry[];
  operation: FileTransferOperation;
}

interface MoveToDialogProps {
  request: MoveToRequest | null;
  /** The folder currently shown — the destination field's starting value. */
  currentPath: string;
  /** Run the move/copy into `destDir` (validation + conflict prompt happen there). */
  onSubmit: (request: MoveToRequest, destDir: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * The keyboard-reachable alternative to drag-to-move (PROD-006): "Move to…" /
 * "Copy to…" on a row or a multi-selection opens this dialog to type the
 * destination folder, and submits through the same guarded move/copy path as a
 * drop.
 */
export function MoveToDialog({ request, currentPath, onSubmit, onClose }: MoveToDialogProps) {
  const [dest, setDest] = useState(currentPath);

  // Re-seed whenever a new request opens the dialog.
  useEffect(() => {
    if (request) setDest(currentPath);
  }, [request, currentPath]);

  const trimmed = dest.trim();
  const verb = request?.operation === "copy" ? "Copy" : "Move";

  const handleSubmit = async () => {
    if (!request || trimmed === "") return;
    onClose();
    await onSubmit(request, trimmed);
  };

  return (
    <Modal
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${verb} to…`}
      description={
        request ? `${verb} ${describeEntries(request.entries)} to another folder` : undefined
      }
      data-testid="move-to-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="move-to-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={trimmed === ""}
            data-testid="move-to-submit"
          >
            {verb}
          </Button>
        </>
      }
    >
      <div className="move-to-dialog">
        <p className="move-to-dialog__target">
          {request ? `${verb} ${describeEntries(request.entries)}` : ""}
        </p>
        <div className="move-to-dialog__field">
          <label htmlFor="move-to-destination">Destination folder</label>
          <Input
            id="move-to-destination"
            size="sm"
            value={dest}
            spellCheck={false}
            autoFocus
            onChange={(e) => setDest(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            data-testid="move-to-destination"
            aria-label="Destination folder"
          />
        </div>
      </div>
    </Modal>
  );
}
