import { toast } from "@/components/ui";

/**
 * How long a delete stays undoable: the Undo toast's lifetime, and for a
 * deferred delete the delay before it is committed (#5158).
 */
export const UNDO_WINDOW_MS = 10_000;

/** Options for {@link showUndoToast}. */
export interface UndoToastOptions {
  /** Restores what was deleted. Called at most once, from the Undo button. */
  onUndo: () => void;
  /** Reuse an existing toast id, e.g. to resolve a "Deleting…" loading toast. */
  id?: string | number;
  /** `data-testid` for the toast element. */
  testId?: string;
}

/**
 * Show the success toast for a delete that can be undone: it carries an Undo
 * button and stays up for {@link UNDO_WINDOW_MS}. Returns the toast id.
 */
export function showUndoToast(message: string, opts: UndoToastOptions): string | number {
  let used = false;
  return toast.success(message, {
    id: opts.id,
    duration: UNDO_WINDOW_MS,
    testId: opts.testId,
    action: {
      label: "Undo",
      onClick: () => {
        if (used) return;
        used = true;
        opts.onUndo();
      },
    },
  });
}

/** Rejection reason of a deferred delete that the user undid. */
export class DeleteUndoneError extends Error {
  constructor() {
    super("delete undone");
    this.name = "DeleteUndoneError";
  }
}

/** True when `err` is the rejection of an undone deferred delete. */
export function isDeleteUndone(err: unknown): err is DeleteUndoneError {
  return err instanceof DeleteUndoneError;
}

/** A delete whose commit waits out the undo window. */
export interface DeferredDelete {
  /** Settles when the commit ran (or rejects with {@link DeleteUndoneError}). */
  promise: Promise<void>;
  /** Undo: drop the commit. Returns false when it already ran. */
  cancel: () => boolean;
}

/** Commit functions of the deferred deletes still inside their undo window. */
const pending = new Set<() => void>();

/**
 * Hold a delete back for {@link UNDO_WINDOW_MS} before committing it, so an
 * Undo can drop it without touching storage. Used where re-creating the
 * deleted item cannot restore it exactly (a connection folder: removing it
 * re-parents and re-ids its children). The commit runs when the window ends, or
 * earlier from {@link flushPendingDeletes} when the window or app closes.
 */
export function deferDelete(commit: () => Promise<void>): DeferredDelete {
  let resolveFn!: () => void;
  let rejectFn!: (err: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  let settled = false;

  const run = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    pending.delete(run);
    let committed: Promise<void>;
    try {
      committed = commit();
    } catch (err) {
      committed = Promise.reject(err);
    }
    committed.then(resolveFn, rejectFn);
  };
  const timer = setTimeout(run, UNDO_WINDOW_MS);
  pending.add(run);

  const cancel = () => {
    if (settled) return false;
    settled = true;
    clearTimeout(timer);
    pending.delete(run);
    rejectFn(new DeleteUndoneError());
    return true;
  };

  return { promise, cancel };
}

/**
 * Commit every deferred delete now. Called before a window closes or the app
 * quits so a delete inside its undo window is not lost. Resolves once the
 * commits settled (failures are reported by each delete's own handler).
 */
export async function flushPendingDeletes(): Promise<void> {
  const runs = [...pending];
  if (runs.length === 0) return;
  runs.forEach((run) => run());
  // Let the commits' IPC calls be issued before the caller tears down.
  await Promise.resolve();
}
