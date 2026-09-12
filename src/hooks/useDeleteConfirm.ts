import { useCallback, useState } from "react";

/**
 * Props to spread onto a `ConfirmDialog` / `ConfirmDeleteDialog` to wire it to a
 * {@link useDeleteConfirm} state machine. The caller still supplies the dialog's
 * `message` (and any other presentational props), typically derived from
 * {@link DeleteConfirm.pending}.
 */
export interface DeleteConfirmDialogProps {
  /** Open whenever a target is pending confirmation. */
  open: boolean;
  /** Confirm handler — runs the delete and clears the pending target. */
  onConfirm: () => void | Promise<void>;
  /** Cancel handler — clears the pending target without deleting. */
  onCancel: () => void;
}

/** State + actions returned by {@link useDeleteConfirm}. */
export interface DeleteConfirm<T> {
  /** The target awaiting confirmation, or `null` when the dialog is closed. */
  pending: T | null;
  /** Open the confirmation for `target` (e.g. from a row's delete button). */
  request: (target: T) => void;
  /** Confirm the pending delete: clears the target, then runs `onConfirm`. */
  confirm: () => void | Promise<void>;
  /** Dismiss the confirmation without deleting. */
  cancel: () => void;
  /** Convenience bundle to spread onto the confirm dialog. */
  dialogProps: DeleteConfirmDialogProps;
}

/**
 * The `pending` → confirm/cancel state machine that every flat sidebar
 * re-implemented for its delete confirmation (Macro, Workflow, Workspace,
 * Tunnel, EmbeddedServer — UISF-020). Holds the target awaiting confirmation and
 * exposes `request` / `confirm` / `cancel` plus a `dialogProps` bundle.
 *
 * `confirm` clears the pending target **before** invoking `onConfirm` (matching
 * the previous inline handlers, which called `setPendingDelete(null)` first) and
 * returns `onConfirm`'s result so the confirm Button's async pending/error-toast
 * state is preserved. `onConfirm` owns the actual delete and its success/error
 * toasts, which differ per entity.
 *
 * @param onConfirm Runs the delete for a confirmed target; owns its own toasts.
 */
export function useDeleteConfirm<T>(
  onConfirm: (target: T) => void | Promise<void>
): DeleteConfirm<T> {
  const [pending, setPending] = useState<T | null>(null);

  const request = useCallback((target: T) => setPending(target), []);
  const cancel = useCallback(() => setPending(null), []);
  const confirm = useCallback((): void | Promise<void> => {
    if (pending === null) return;
    const target = pending;
    setPending(null);
    return onConfirm(target);
  }, [pending, onConfirm]);

  return {
    pending,
    request,
    confirm,
    cancel,
    dialogProps: { open: pending !== null, onConfirm: confirm, onCancel: cancel },
  };
}
