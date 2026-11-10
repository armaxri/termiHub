import { useCallback } from "react";
import type { ConfirmDontAskAgain } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import {
  persistUndoableDeleteOptOut,
  useUndoableDeleteOptOut,
} from "@/hooks/useUndoableDeleteOptOut";
import { tunnelDeleteConfirmMessage } from "@/utils/tunnelSummary";

/** Props to spread onto a `ConfirmDeleteDialog` for a tunnel delete. */
export interface TunnelDeleteDialogProps {
  open: boolean;
  message: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  dontAskAgain?: ConfirmDontAskAgain;
}

/** State returned by {@link useTunnelDeleteConfirm}. */
export interface TunnelDeleteConfirm {
  /** Start deleting a tunnel: confirms first unless the user opted out. */
  requestDelete: (tunnelId: string) => void;
  /** Spread onto `ConfirmDeleteDialog`. */
  dialogProps: TunnelDeleteDialogProps;
}

/**
 * The tunnel delete flow shared by every place that deletes a tunnel (the
 * Tunnels sidebar and the connection editor's Port Forwarding section, #5158 /
 * #5216). An active teardown, a chained-pair cascade or a companion delete
 * always confirms, with no opt-out. A plain idle delete confirms with a "don't
 * ask again" opt-out (the `confirmUndoableDelete` setting). Every delete is
 * undoable: `deleteTunnel(id, { undoable: true })` shows the 10 s Undo toast,
 * which re-creates the tunnel and its companion hop under the same ids.
 */
export function useTunnelDeleteConfirm(): TunnelDeleteConfirm {
  const tunnels = useAppStore((s) => s.tunnels);
  const tunnelStates = useAppStore((s) => s.tunnelStates);
  const deleteTunnel = useAppStore((s) => s.deleteTunnel);

  const optOut = useUndoableDeleteOptOut();
  const takeOptOut = optOut.take;
  const resetOptOut = optOut.reset;
  const shouldConfirm = optOut.shouldConfirm;

  // `deleteTunnel` owns its success (Undo) and error toasts.
  const confirm = useDeleteConfirm<{ id: string; message: string; undoable: boolean }>(
    ({ id, undoable }) => {
      if (undoable && takeOptOut()) persistUndoableDeleteOptOut();
      void deleteTunnel(id, { undoable: true });
    }
  );
  const request = confirm.request;
  const cancel = confirm.cancel;

  const requestDelete = useCallback(
    (tunnelId: string) => {
      const message = tunnelDeleteConfirmMessage(tunnels, tunnelStates, tunnelId);
      if (message) {
        request({ id: tunnelId, message, undoable: false });
        return;
      }
      if (!shouldConfirm) {
        void deleteTunnel(tunnelId, { undoable: true });
        return;
      }
      const name = tunnels.find((t) => t.id === tunnelId)?.name ?? "this tunnel";
      request({ id: tunnelId, message: `Delete tunnel “${name}”?`, undoable: true });
    },
    [tunnels, tunnelStates, deleteTunnel, request, shouldConfirm]
  );

  const onCancel = useCallback(() => {
    resetOptOut();
    cancel();
  }, [resetOptOut, cancel]);

  return {
    requestDelete,
    dialogProps: {
      open: confirm.dialogProps.open,
      onConfirm: confirm.dialogProps.onConfirm,
      onCancel,
      message: confirm.pending?.message ?? "",
      dontAskAgain: confirm.pending?.undoable ? optOut.dontAskAgain : undefined,
    },
  };
}
