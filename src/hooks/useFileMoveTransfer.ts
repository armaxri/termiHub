import { useCallback, useState } from "react";
import { toast } from "@/components/ui";
import { localListDir, sessionListFiles } from "@/services/api";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import type { FileClipboard } from "@/store/appStore";
import type { FileEntry } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";
import {
  describeEntries,
  findNameConflicts,
  parentDirPath,
  planFileDrop,
  type FileTransferOperation,
  type PasteOptions,
} from "@/utils/fileDragMove";

/** A move/copy waiting on the user's overwrite confirmation. */
export interface PendingFileMoveConflict {
  entries: FileEntry[];
  destDir: string;
  operation: FileTransferOperation;
  /** Names already present in the destination, or `null` when it could not be listed. */
  conflicts: string[] | null;
  /**
   * `true` when this is a plain Paste of the user's copy/cut clipboard (#3458):
   * confirming runs the pane's normal paste (which clears a cut clipboard) rather
   * than a one-shot move/copy of `entries`.
   */
  fromClipboard?: boolean;
}

/** Inputs for {@link useFileMoveTransfer}. */
export interface UseFileMoveTransferArgs {
  /** The browser's active pane. */
  mode: "local" | "session" | "none";
  /** The live session backing a `session` pane (ignored for `local`). */
  sessionId: string | null;
  /** The pane's paste action, reused so every transport path stays shared. */
  pasteEntry: (options?: PasteOptions) => Promise<void>;
}

/** What {@link useFileMoveTransfer} exposes to the file browser. */
export interface FileMoveTransfer {
  /** Validate, conflict-check, and run (or queue for confirmation) a move/copy. */
  requestTransfer: (
    entries: FileEntry[],
    destDir: string,
    operation: FileTransferOperation,
    destEntry?: FileEntry | null
  ) => Promise<void>;
  /**
   * Paste the user's copy/cut clipboard into `destDir` (the pane's current
   * folder) through the same guards, conflict prompt and feedback as a drag or
   * Move to… request. Never rejects.
   */
  requestPaste: (destDir: string) => Promise<void>;
  /** The request awaiting overwrite confirmation, if any. */
  pendingConflict: PendingFileMoveConflict | null;
  /** Proceed with the pending request, replacing the conflicting names. */
  confirmConflict: () => Promise<void>;
  /** Abandon the pending request. */
  cancelConflict: () => void;
}

/**
 * Move or copy file-browser entries into another folder of the same pane — the
 * engine behind drag-to-move and the "Move to… / Copy to…" dialog (PROD-006).
 *
 * The request is planned by {@link planFileDrop} (refusing a folder into its own
 * subtree or a read-only destination), then the destination is listed so a name
 * collision is confirmed before anything is replaced. Execution reuses the pane's
 * `pasteEntry` with a one-shot clipboard, so a same-filesystem move is a
 * server-side rename (no data copy), a same-session SFTP copy is a server-side
 * `session_copy`, and every other shape keeps the existing transfer-queue /
 * byte-based paths — without disturbing the user's copy/cut clipboard.
 */
export function useFileMoveTransfer({
  mode,
  sessionId,
  pasteEntry,
}: UseFileMoveTransferArgs): FileMoveTransfer {
  const [pendingConflict, setPendingConflict] = useState<PendingFileMoveConflict | null>(null);

  const execute = useCallback(
    async (entries: FileEntry[], destDir: string, operation: FileTransferOperation) => {
      if (mode === "none" || entries.length === 0) return;
      const sourceMode = mode;
      const clipboard: FileClipboard = {
        entries,
        operation: operation === "move" ? "cut" : "copy",
        sourceMode,
        sourcePath: parentDirPath(entries[0].path),
        terminalSessionId: sourceMode === "session" ? sessionId : null,
      };
      const verb = operation === "move" ? "Move" : "Copy";
      const options: PasteOptions = { clipboard, destDir, verb };
      frontendLog(
        "file_browser",
        `${verb} ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → ${destDir}`
      );
      // Both panes' paste own their loading → success/error feedback (the local
      // one as a summary toast, the session one per item on the transfer queue)
      // and never reject, so there is nothing to wrap here (#3458).
      await pasteEntry(options);
    },
    [mode, sessionId, pasteEntry]
  );

  const listDestinationNames = useCallback(
    async (destDir: string): Promise<string[] | null> => {
      try {
        const listing =
          mode === "session" && sessionId
            ? await sessionListFiles(sessionId, destDir)
            : await localListDir(destDir);
        return listing.map((e) => e.name);
      } catch (err) {
        frontendLog("file_browser", `Could not list ${destDir} for conflicts: ${err}`);
        return null;
      }
    },
    [mode, sessionId]
  );

  const requestTransfer = useCallback(
    async (
      entries: FileEntry[],
      destDir: string,
      operation: FileTransferOperation,
      destEntry?: FileEntry | null
    ) => {
      if (mode === "none" || (mode === "session" && !sessionId)) return;
      const plan = planFileDrop(entries, destDir, operation, destEntry);
      if (plan.kind === "refuse") {
        toast.error(plan.message);
        return;
      }
      if (plan.kind === "noop") return;
      const names = await listDestinationNames(destDir);
      const conflicts = names === null ? null : findNameConflicts(plan.entries, names);
      if (conflicts === null || conflicts.length > 0) {
        // Never replace (or blindly write into an unverifiable destination)
        // without the user's say-so.
        setPendingConflict({ entries: plan.entries, destDir, operation, conflicts });
        return;
      }
      await execute(plan.entries, destDir, operation);
    },
    [mode, sessionId, listDestinationNames, execute]
  );

  const requestPaste = useCallback(
    async (destDir: string) => {
      const clipboard = currentFileBrowsersView().clipboard;
      if (mode === "none" || (mode === "session" && !sessionId)) return;
      if (!clipboard || clipboard.entries.length === 0) return;
      if (mode === "local" && clipboard.sourceMode !== "local") {
        // Unsupported direction: the local paste explains that itself.
        await pasteEntry();
        return;
      }
      const operation: FileTransferOperation = clipboard.operation === "cut" ? "move" : "copy";
      // The into-self / same-folder guards only make sense when the clipboard
      // lives on the same filesystem as this pane.
      const sameFilesystem =
        clipboard.sourceMode === mode &&
        (mode === "local" || (clipboard.terminalSessionId ?? sessionId) === sessionId);
      let entries = clipboard.entries;
      if (sameFilesystem) {
        const plan = planFileDrop(entries, destDir, operation);
        if (plan.kind === "refuse") {
          toast.error(plan.message);
          return;
        }
        if (plan.kind === "noop") {
          // Pasting into the folder the items came from would move them onto
          // themselves (or clobber the source on a copy): say so, do nothing.
          toast.info(
            `${describeEntries(entries)} ${entries.length === 1 ? "is" : "are"} already in ${destDir}`
          );
          return;
        }
        entries = plan.entries;
      }
      const names = await listDestinationNames(destDir);
      const conflicts = names === null ? null : findNameConflicts(entries, names);
      if (conflicts === null || conflicts.length > 0) {
        setPendingConflict({ entries, destDir, operation, conflicts, fromClipboard: true });
        return;
      }
      frontendLog(
        "file_browser",
        `Paste ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → ${destDir}`
      );
      await pasteEntry({ destDir });
    },
    [mode, sessionId, pasteEntry, listDestinationNames]
  );

  const confirmConflict = useCallback(async () => {
    const pending = pendingConflict;
    setPendingConflict(null);
    if (!pending) return;
    if (pending.fromClipboard) {
      await pasteEntry({ destDir: pending.destDir });
      return;
    }
    await execute(pending.entries, pending.destDir, pending.operation);
  }, [pendingConflict, execute, pasteEntry]);

  const cancelConflict = useCallback(() => setPendingConflict(null), []);

  return { requestTransfer, requestPaste, pendingConflict, confirmConflict, cancelConflict };
}
