import { StateCreator } from "zustand";

import { sftpCancelTransfer } from "@/services/api";
import { dispatchTransferIntentBestEffort } from "@/store/transfersBridge";
import { TransferState } from "@/types/connection";
import { frontendLog } from "@/utils/frontendLog";

import { omitKey, windowOwnsTransferSession, withComposedLayout, type AppState } from "../appStore";

/**
 * SFTP transfer domain slice — a cut of the appStore god-module split
 * (ARCH-001 / FES-011), following the first slice PR #2880.
 *
 * Two adjacent concerns live here:
 *
 * 1. The transient {@link TransfersSlice.transfers} map — live in-flight SFTP
 *    transfers keyed by `transferId`, fed purely by `transfer-progress` events
 *    through {@link TransfersSlice.applyTransferProgress}. It is rendered by the
 *    Open Connections "Transfers" section, the file-browser footer, and the
 *    status-bar aggregate. This map is authoritative in `appStore` (the window
 *    that owns a session folds its own progress here).
 *
 * 2. The **Transfer Queue panel** mutations ({@link TransfersSlice.removeTransfer},
 *    {@link TransfersSlice.clearCompleted}, {@link TransfersSlice.setTransferQueueMinimized}).
 *    Since #2229 the shared `transfers` projection region is authoritative — the
 *    backend folds the live progress stream into it at the source (#2387) — so
 *    the panel reads its rows via `useProjectedTransfers()` and these panel-only
 *    actions dispatch reliable client `transfer.*` intents against that region.
 *    `appStore` holds no queue state.
 *
 * The window-ownership guard in `applyTransferProgress` reaches the layout
 * projection through the shared `withComposedLayout` / `windowOwnsTransferSession`
 * helpers (still owned by the not-yet-extracted layout/window domain), and reads
 * `releasedTransferSessions` off the composed `AppState` via `set`.
 */
export interface TransfersSlice {
  /**
   * Live in-flight SFTP transfers keyed by `transferId` (concept "SFTP session
   * tracking + transfers", issue #1247). Fed purely by `transfer-progress`
   * events (#1245) through {@link applyTransferProgress}; a terminal phase
   * clears the row. Rendered as the Open Connections "Transfers" section, the
   * file-browser footer, and the status-bar aggregate.
   */
  transfers: Record<string, TransferState>;
  /**
   * Apply a `transfer-progress` event to the {@link transfers} map: a
   * `transferring` phase upserts the row; a terminal phase
   * (`done`/`cancelled`/`error`) removes it (D2 done/error toasts are handled
   * separately).
   */
  applyTransferProgress: (progress: TransferState) => void;
  /** Request cancellation of an in-flight transfer (`sftp_cancel_transfer`). */
  cancelTransfer: (transferId: string) => Promise<void>;

  /**
   * The **Transfer Queue panel** slice (rows keyed by `transferId` + the
   * panel-minimized flag) is no longer held in `appStore`. Since #2229 the shared
   * `transfers` projection region is authoritative — the backend folds the live
   * `transfer-progress` stream into it at the source (#2387) — so the panel reads
   * the rows via {@link import("../useProjectedTransfers").useProjectedTransfers}
   * and the panel-only mutations below dispatch client `transfer.*` intents
   * against that region. The transient {@link transfers} map (above) is separate
   * and stays authoritative in `appStore`.
   *
   * Remove a single queue row (per-row Remove control) via `transfer.remove`.
   */
  removeTransfer: (id: string) => void;
  /**
   * Remove every `completed` row (footer Clear Completed) via
   * `transfer.clearCompleted`; failed/cancelled stay.
   */
  clearCompleted: () => void;
  /**
   * Collapse/expand the panel to/from its status-bar indicator via
   * `transfer.setMinimized`.
   */
  setTransferQueueMinimized: (minimized: boolean) => void;
}

export const createTransfersSlice: StateCreator<AppState, [], [], TransfersSlice> = (set) => ({
  // File browser — SFTP transfers
  transfers: {},

  applyTransferProgress: (progress: TransferState) =>
    set((state) => {
      // A transfer whose session this window handed to another window (#1951)
      // is no longer ours: ignore its broadcast progress so a moved-away row is
      // not re-created here.
      if (state.releasedTransferSessions.includes(progress.sessionId)) return {};
      // Scope the fold to the owning window even without a move (#1964): a
      // `transfer-progress` event is broadcast to every window, but only the
      // window that owns the session should show it.
      if (!windowOwnsTransferSession(withComposedLayout(state), progress.sessionId)) return {};
      // A terminal phase clears the row (D1 already removed any partial local
      // file on cancel/error). done/error toasts are the D2 follow-up.
      if (progress.phase !== "transferring") {
        if (!(progress.transferId in state.transfers)) return {};
        return { transfers: omitKey(state.transfers, progress.transferId) };
      }
      return {
        transfers: { ...state.transfers, [progress.transferId]: progress },
      };
    }),

  cancelTransfer: async (transferId: string) => {
    try {
      await sftpCancelTransfer(transferId);
    } catch (err) {
      frontendLog(
        "sftp_transfer",
        `cancelTransfer: cancel of ${transferId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      throw err;
    }
  },

  // --- Transfer Queue panel mutations (#1337, region-authoritative #2229) ---
  //
  // The Transfer Queue panel state lives in the shared, authoritative
  // `transfers` projection region — the backend folds the live progress stream
  // into it at the source (#2387). These panel-only actions have no live-engine
  // data source, so they are reliable client `transfer.*` intents against that
  // region (dispatch is best-effort: a bridge hiccup is swallowed and logged,
  // never thrown out of a UI action). `appStore` holds no queue state.

  removeTransfer: (id: string) => {
    dispatchTransferIntentBestEffort("transfer.remove", { id });
  },

  clearCompleted: () => {
    dispatchTransferIntentBestEffort("transfer.clearCompleted", {});
  },

  setTransferQueueMinimized: (minimized: boolean) => {
    dispatchTransferIntentBestEffort("transfer.setMinimized", { minimized });
  },
});
