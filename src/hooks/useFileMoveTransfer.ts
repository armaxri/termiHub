import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/ui";
import { localListDir, sessionListFiles } from "@/services/api";
import { currentFileBrowsersView } from "@/store/fileBrowsersBridge";
import type { FileClipboard } from "@/store/appStore";
import type { FileEntry } from "@/types/connection";
import { frontendDurableInfo, frontendLog } from "@/utils/frontendLog";
import {
  describeEntries,
  findNameConflicts,
  isAlreadyExistsError,
  keepBothName,
  planFileDrop,
  type FileTransferOperation,
  type PasteOptions,
} from "@/utils/fileDragMove";
import { errorMessage } from "@/utils/errorMessage";
import { parentDir } from "@/utils/paths";

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

/** The single-entry writes guarded by {@link FileMoveTransfer.requestWrite} (#5157). */
export type FileWriteVerb = "Rename" | "Upload" | "Create";

/**
 * A rename, upload or New File that would land `name` in `destDir`, routed
 * through the same exists-check and "{Verb} and Replace?" prompt as a move or
 * paste (#5157).
 */
export interface FileWriteRequest {
  verb: FileWriteVerb;
  /** The folder the entry is written into. */
  destDir: string;
  /** The entry name the write creates or replaces. */
  name: string;
  /** Whether the written entry is a folder (shapes the "Keep both" name). */
  isDirectory?: boolean;
  /** Offer "Keep Both" (write under a free name) next to Replace / Skip. */
  allowKeepBoth?: boolean;
  /**
   * Perform the write as `name`. `overwrite` is `true` only once the user
   * confirmed replacing the existing entry; otherwise the transport should
   * refuse to clobber where it can (an atomic no-replace rename / exclusive
   * create), and a rejection that says the target already exists re-opens the
   * prompt instead of failing.
   */
  run: (name: string, overwrite: boolean) => Promise<void>;
  /** Called after a successful `run`, with the name actually written. */
  onDone?: (name: string) => void;
  /** Called when `run` rejects (other than the already-exists race above). */
  onError?: (err: unknown) => void;
}

/** A rename / upload / New File waiting on the user's overwrite decision. */
export interface PendingFileWriteConflict {
  kind: "write";
  verb: FileWriteVerb;
  destDir: string;
  name: string;
  /** `[name]` when the entry exists, or `null` when `destDir` could not be listed. */
  conflicts: string[] | null;
  /** The free name "Keep Both" writes to, or `null` when it is not offered. */
  keepBothName: string | null;
}

/** Whatever the conflict dialog is currently asking about. */
export type PendingFileConflict = PendingFileMoveConflict | PendingFileWriteConflict;

/** Whether a pending conflict is a single-entry write (#5157) rather than a move/copy. */
export function isWriteConflict(
  pending: PendingFileConflict | null
): pending is PendingFileWriteConflict {
  return pending !== null && "kind" in pending && pending.kind === "write";
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
  /**
   * Check `request.name` against `request.destDir` and run the write — at once
   * when nothing is in the way, or after the user chose Replace / Keep Both in
   * the conflict prompt (#5157). Resolves once the request is finished
   * (written, skipped or failed), so a caller can sequence several drops.
   * Never rejects.
   */
  requestWrite: (request: FileWriteRequest) => Promise<void>;
  /** The request awaiting overwrite confirmation, if any. */
  pendingConflict: PendingFileConflict | null;
  /** Proceed with the pending request, replacing the conflicting names. */
  confirmConflict: () => Promise<void>;
  /** Write the pending single-entry request under its free "Keep Both" name. */
  keepBothConflict: () => Promise<void>;
  /** Abandon (skip) the pending request. */
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
  const [pendingConflict, setPendingConflict] = useState<PendingFileConflict | null>(null);
  // The pending write's request and the resolver of its `requestWrite` promise
  // (not render state: only the dialog's choice handlers read them).
  const pendingWriteRef = useRef<{ request: FileWriteRequest; resolve: () => void } | null>(null);

  const execute = useCallback(
    async (entries: FileEntry[], destDir: string, operation: FileTransferOperation) => {
      if (mode === "none" || entries.length === 0) return;
      const sourceMode = mode;
      const clipboard: FileClipboard = {
        entries,
        operation: operation === "move" ? "cut" : "copy",
        sourceMode,
        sourcePath: parentDir(entries[0].path),
        terminalSessionId: sourceMode === "session" ? sessionId : null,
      };
      const verb = operation === "move" ? "Move" : "Copy";
      const options: PasteOptions = { clipboard, destDir, verb };
      // Durable (#4110): a drag that reaches the engine must leave a trace in
      // termihub.log, so a "nothing moved" failure tells drop-never-arrived apart
      // from transfer-ran.
      frontendDurableInfo(
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
        frontendLog(
          "file_browser",
          `Could not list ${destDir} for conflicts: ${errorMessage(err)}`
        );
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
        frontendDurableInfo(
          "file_browser",
          `${operation} into ${destDir} refused: ${plan.message}`
        );
        toast.error(plan.message);
        return;
      }
      if (plan.kind === "noop") {
        frontendDurableInfo(
          "file_browser",
          `${operation} into ${destDir} skipped: every entry already lives there`
        );
        return;
      }
      const names = await listDestinationNames(destDir);
      const conflicts = names === null ? null : findNameConflicts(plan.entries, names);
      if (conflicts === null || conflicts.length > 0) {
        frontendDurableInfo(
          "file_browser",
          `${operation} into ${destDir} awaits overwrite confirmation ` +
            `(conflicts: ${conflicts === null ? "destination not listable" : conflicts.join(", ")})`
        );
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

  /** Settle a pending write's `requestWrite` promise (the prompt is done with it). */
  const settlePendingWrite = useCallback(() => {
    const write = pendingWriteRef.current;
    pendingWriteRef.current = null;
    write?.resolve();
  }, []);

  /**
   * Run a write; a no-clobber refusal (the target appeared after the
   * exists-check, or the listing missed it — e.g. a case-insensitive
   * filesystem) re-opens the prompt instead of failing. Resolves to whether the
   * request is finished (`false` = now awaiting the prompt).
   */
  const attemptWrite = useCallback(
    async (request: FileWriteRequest, name: string, overwrite: boolean): Promise<boolean> => {
      try {
        await request.run(name, overwrite);
        request.onDone?.(name);
        return true;
      } catch (err) {
        if (!overwrite && isAlreadyExistsError(err)) {
          frontendDurableInfo(
            "file_browser",
            `${request.verb} of ${name} into ${request.destDir} refused: target already exists`
          );
          setPendingConflict({
            kind: "write",
            verb: request.verb,
            destDir: request.destDir,
            name,
            conflicts: [name],
            keepBothName: null,
          });
          return false;
        }
        request.onError?.(err);
        return true;
      }
    },
    []
  );

  const requestWrite = useCallback(
    (request: FileWriteRequest): Promise<void> =>
      new Promise<void>((resolve) => {
        void (async () => {
          // A new request supersedes one still waiting on the prompt (skipped).
          if (pendingWriteRef.current) {
            setPendingConflict((p) => (isWriteConflict(p) ? null : p));
            settlePendingWrite();
          }
          const names = await listDestinationNames(request.destDir);
          const conflicts =
            names === null ? null : names.includes(request.name) ? [request.name] : [];
          if (conflicts !== null && conflicts.length === 0) {
            pendingWriteRef.current = { request, resolve };
            const finished = await attemptWrite(request, request.name, false);
            if (finished) settlePendingWrite();
            return;
          }
          frontendDurableInfo(
            "file_browser",
            `${request.verb} of ${request.name} into ${request.destDir} awaits overwrite ` +
              `confirmation (${conflicts === null ? "destination not listable" : "name exists"})`
          );
          pendingWriteRef.current = { request, resolve };
          setPendingConflict({
            kind: "write",
            verb: request.verb,
            destDir: request.destDir,
            name: request.name,
            conflicts,
            keepBothName: request.allowKeepBoth
              ? keepBothName(request.name, names ?? [], request.isDirectory)
              : null,
          });
        })();
      }),
    [listDestinationNames, attemptWrite, settlePendingWrite]
  );

  const keepBothConflict = useCallback(async () => {
    const pending = pendingConflict;
    const write = pendingWriteRef.current;
    setPendingConflict(null);
    if (!isWriteConflict(pending) || !write || pending.keepBothName === null) {
      settlePendingWrite();
      return;
    }
    // Keep Both writes a name that was free a moment ago without overwrite, so
    // a racing creator of that name re-opens the prompt rather than losing data.
    const finished = await attemptWrite(write.request, pending.keepBothName, false);
    if (finished) settlePendingWrite();
  }, [pendingConflict, attemptWrite, settlePendingWrite]);

  const confirmConflict = useCallback(async () => {
    const pending = pendingConflict;
    setPendingConflict(null);
    if (!pending) return;
    if (isWriteConflict(pending)) {
      const write = pendingWriteRef.current;
      if (write) await attemptWrite(write.request, pending.name, true);
      settlePendingWrite();
      return;
    }
    if (pending.fromClipboard) {
      await pasteEntry({ destDir: pending.destDir });
      return;
    }
    await execute(pending.entries, pending.destDir, pending.operation);
  }, [pendingConflict, execute, pasteEntry, attemptWrite, settlePendingWrite]);

  const cancelConflict = useCallback(() => {
    setPendingConflict(null);
    settlePendingWrite();
  }, [settlePendingWrite]);

  return {
    requestTransfer,
    requestPaste,
    requestWrite,
    pendingConflict,
    confirmConflict,
    keepBothConflict,
    cancelConflict,
  };
}
