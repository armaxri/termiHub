/**
 * UI state for the diagnostics dialogs (OBS-010): the "Export diagnostics"
 * dialog and the crash-report viewer. Kept in its own tiny store rather than the
 * app store — it is transient, per-window UI state that several entry points
 * (the settings menu, General settings, the crash notice) open.
 */

import { create } from "zustand";

/** A crash report on a remote agent, opened in the viewer (#3593). */
export interface ViewedAgentReport {
  agentId: string;
  name: string;
}

interface DiagnosticsDialogState {
  /** Whether the "Export diagnostics" dialog is open. */
  exportOpen: boolean;
  /** File name of the crash report being viewed, or `null` when closed. */
  viewedReport: string | null;
  /** Remote agent crash report being viewed, or `null` (#3593). */
  viewedAgentReport: ViewedAgentReport | null;
  /** Open or close the export dialog. */
  setExportOpen: (open: boolean) => void;
  /** Open the viewer on a report (`null` closes it). */
  setViewedReport: (name: string | null) => void;
  /** Open the viewer on a remote agent's report (`null` closes it). */
  setViewedAgentReport: (report: ViewedAgentReport | null) => void;
}

export const useDiagnosticsDialogStore = create<DiagnosticsDialogState>((set) => ({
  exportOpen: false,
  viewedReport: null,
  viewedAgentReport: null,
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setViewedReport: (viewedReport) => set({ viewedReport, viewedAgentReport: null }),
  setViewedAgentReport: (viewedAgentReport) => set({ viewedAgentReport, viewedReport: null }),
}));

/** Open the "Export diagnostics" dialog from anywhere (menus, settings). */
export function openDiagnosticsExport(): void {
  useDiagnosticsDialogStore.getState().setExportOpen(true);
}
