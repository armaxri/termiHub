/**
 * UI state for the diagnostics dialogs (OBS-010): the "Export diagnostics"
 * dialog and the crash-report viewer. Kept in its own tiny store rather than the
 * app store — it is transient, per-window UI state that several entry points
 * (the settings menu, General settings, the crash notice) open.
 */

import { create } from "zustand";

interface DiagnosticsDialogState {
  /** Whether the "Export diagnostics" dialog is open. */
  exportOpen: boolean;
  /** File name of the crash report being viewed, or `null` when closed. */
  viewedReport: string | null;
  /** Open or close the export dialog. */
  setExportOpen: (open: boolean) => void;
  /** Open the viewer on a report (`null` closes it). */
  setViewedReport: (name: string | null) => void;
}

export const useDiagnosticsDialogStore = create<DiagnosticsDialogState>((set) => ({
  exportOpen: false,
  viewedReport: null,
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setViewedReport: (viewedReport) => set({ viewedReport }),
}));

/** Open the "Export diagnostics" dialog from anywhere (menus, settings). */
export function openDiagnosticsExport(): void {
  useDiagnosticsDialogStore.getState().setExportOpen(true);
}
