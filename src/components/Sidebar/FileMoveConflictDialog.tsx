import { ConfirmDialog } from "@/components/ui";
import type { PendingFileMoveConflict } from "@/hooks/useFileMoveTransfer";

interface FileMoveConflictDialogProps {
  /** The move/copy awaiting confirmation, or `null` when closed. */
  pending: PendingFileMoveConflict | null;
  /** Proceed, replacing the conflicting names. */
  onConfirm: () => void | Promise<void>;
  /** Abandon the move/copy. */
  onCancel: () => void;
}

/** Summarise the conflicting names ("a.txt", "a.txt, b.txt", "a.txt and 4 more"). */
function conflictSummary(names: string[]): string {
  if (names.length <= 3) return names.map((n) => `"${n}"`).join(", ");
  return `${names
    .slice(0, 3)
    .map((n) => `"${n}"`)
    .join(", ")} and ${names.length - 3} more`;
}

/**
 * Confirms a drag-to-move / Move to… request that would replace items already
 * in the destination folder — or that targets a folder that could not be listed
 * to check (PROD-006). Nothing is overwritten without this confirmation.
 */
export function FileMoveConflictDialog({
  pending,
  onConfirm,
  onCancel,
}: FileMoveConflictDialogProps) {
  const verb = pending?.fromClipboard ? "Paste" : pending?.operation === "copy" ? "Copy" : "Move";
  const message = !pending
    ? ""
    : pending.conflicts === null
      ? `Could not check ${pending.destDir} for existing items. ${verb} anyway? Items with the same name will be replaced.`
      : `${conflictSummary(pending.conflicts)} already ${
          pending.conflicts.length === 1 ? "exists" : "exist"
        } in ${pending.destDir}. Replace ${pending.conflicts.length === 1 ? "it" : "them"}?`;
  return (
    <ConfirmDialog
      open={pending !== null}
      title={`${verb} and Replace?`}
      variant="warn"
      message={message}
      confirmLabel={`${verb} and Replace`}
      confirmVariant="danger"
      testIdBase="file-move-conflict"
      data-testid="file-move-conflict-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
