import { ConfirmDialog } from "@/components/ui";
import {
  isWriteConflict,
  type PendingFileConflict,
  type PendingFileWriteConflict,
} from "@/hooks/useFileMoveTransfer";

interface FileMoveConflictDialogProps {
  /** The move/copy or rename/upload/New File awaiting confirmation, or `null` when closed. */
  pending: PendingFileConflict | null;
  /** Proceed, replacing the conflicting names. */
  onConfirm: () => void | Promise<void>;
  /**
   * Write the pending upload under its free name instead ("Keep Both",
   * #5157). Only offered when the pending request carries a `keepBothName`.
   */
  onKeepBoth?: () => void | Promise<void>;
  /** Abandon (skip) the request. */
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

/** The dialog's verb ("Move", "Paste", "Rename", "Upload", "Create"). */
function conflictVerb(pending: PendingFileConflict | null): string {
  if (isWriteConflict(pending)) return pending.verb;
  return pending?.fromClipboard ? "Paste" : pending?.operation === "copy" ? "Copy" : "Move";
}

/** The body of a rename / upload / New File prompt (#5157). */
function writeMessage(pending: PendingFileWriteConflict): string {
  if (pending.conflicts === null) {
    return `Could not check ${pending.destDir} for existing items. ${pending.verb} "${pending.name}" anyway? An item with the same name will be replaced.`;
  }
  const keepBoth = pending.keepBothName ? ` or keep both as "${pending.keepBothName}"` : "";
  return `"${pending.name}" already exists in ${pending.destDir}. Replace it${keepBoth}?`;
}

/**
 * Confirms a request that would replace items already in the destination
 * folder — or that targets a folder that could not be listed to check: a
 * drag-to-move / Move to… / Paste (PROD-006), and a rename, upload or New File
 * (#5157). Nothing is overwritten without this confirmation. An upload also
 * offers "Keep Both" (write under a free name), and its cancel reads "Skip".
 */
export function FileMoveConflictDialog({
  pending,
  onConfirm,
  onKeepBoth,
  onCancel,
}: FileMoveConflictDialogProps) {
  const verb = conflictVerb(pending);
  const write = isWriteConflict(pending) ? pending : null;
  const message = !pending
    ? ""
    : write
      ? writeMessage(write)
      : pending.conflicts === null
        ? `Could not check ${pending.destDir} for existing items. ${verb} anyway? Items with the same name will be replaced.`
        : `${conflictSummary(pending.conflicts)} already ${
            pending.conflicts.length === 1 ? "exists" : "exist"
          } in ${pending.destDir}. Replace ${pending.conflicts.length === 1 ? "it" : "them"}?`;
  const keepBoth =
    write?.keepBothName && onKeepBoth ? { label: "Keep Both", onClick: onKeepBoth } : undefined;
  return (
    <ConfirmDialog
      open={pending !== null}
      title={`${verb} and Replace?`}
      variant="warn"
      message={message}
      confirmLabel={`${verb} and Replace`}
      confirmVariant="danger"
      cancelLabel={write?.verb === "Upload" ? "Skip" : "Cancel"}
      alternateAction={keepBoth}
      testIdBase="file-move-conflict"
      data-testid="file-move-conflict-dialog"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
