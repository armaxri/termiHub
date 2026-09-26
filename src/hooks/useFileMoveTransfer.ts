import { useCallback, useState } from "react";
import { toast } from "@/components/ui";
import { localListDir, sessionListFiles } from "@/services/api";
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
import { runBlockingTransfer } from "./transferFeedback";

/** A move/copy waiting on the user's overwrite confirmation. */
export interface PendingFileMoveConflict {
  entries: FileEntry[];
  destDir: string;
  operation: FileTransferOperation;
  /** Names already present in the destination, or `null` when it could not be listed. */
  conflicts: string[] | null;
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
      if (sourceMode === "session") {
        // The session paste owns per-item progress/success/error feedback and
        // routes onto the transfer queue where the transport supports it.
        await pasteEntry(options);
        return;
      }
      // The local paste is a blocking rename/copy with no transfer events, so
      // own the loading → success/error feedback here.
      const what = describeEntries(entries);
      await runBlockingTransfer(() => pasteEntry(options), {
        loading: `${operation === "move" ? "Moving" : "Copying"} ${what}…`,
        success: `${operation === "move" ? "Moved" : "Copied"} ${what} to ${destDir}`,
        errorLabel: `${verb} ${what}`,
      });
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
      if (mode === "none") return;
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
    [mode, listDestinationNames, execute]
  );

  const confirmConflict = useCallback(async () => {
    const pending = pendingConflict;
    setPendingConflict(null);
    if (!pending) return;
    await execute(pending.entries, pending.destDir, pending.operation);
  }, [pendingConflict, execute]);

  const cancelConflict = useCallback(() => setPendingConflict(null), []);

  return { requestTransfer, pendingConflict, confirmConflict, cancelConflict };
}
