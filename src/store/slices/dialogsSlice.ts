import { StateCreator } from "zustand";

import type { RecoveryWarning } from "@/types/connection";

import type { AppState } from "../appStore";

/**
 * Dialogs domain slice (extracted under #2077 via #2300): the small,
 * self-contained confirmation/dialog state that is not tied to any
 * projection-migration domain — the large-paste confirmation, the
 * open-saved-file-in-tab confirmation, the export/import dialogs, and the
 * corrupt-config recovery-warnings dialog — together with their open/close
 * setters. Extracted verbatim from the monolithic root store as a
 * behavior-preserving Zustand slice: every action still receives the shared
 * `set` typed against the full {@link AppState}, so the public store shape and
 * behavior are unchanged. Note that `loadFromBackend` (kept in the root store)
 * still populates {@link recoveryWarnings}/{@link recoveryDialogOpen} through
 * that same shared `set`. Mirrors the SSH tunnel slice (#2077) and the
 * embedded-server / macros / plugins / session-history / zoom / command-palette
 * / http-monitors slices (#2113/#2114/#2115/#2299/#2300).
 */

export interface DialogsSlice {
  // Large paste confirmation
  largePasteDialog: { open: boolean; charCount: number; onConfirm: (() => void) | null };
  showLargePasteDialog: (charCount: number, onConfirm: () => void) => void;
  closeLargePasteDialog: () => void;

  // Open-saved-file-in-tab confirmation
  openSavedFileDialog: { open: boolean; filePath: string };
  showOpenSavedFileDialog: (filePath: string) => void;
  closeOpenSavedFileDialog: () => void;

  // Export/Import dialogs
  exportDialogOpen: boolean;
  setExportDialogOpen: (open: boolean) => void;
  importDialogOpen: boolean;
  importFileContent: string | undefined;
  setImportDialog: (open: boolean, content?: string) => void;

  // Recovery warnings from corrupt config files
  recoveryWarnings: RecoveryWarning[];
  recoveryDialogOpen: boolean;
  setRecoveryDialogOpen: (open: boolean) => void;
}

export const createDialogsSlice: StateCreator<AppState, [], [], DialogsSlice> = (set) => ({
  // Large paste confirmation
  largePasteDialog: { open: false, charCount: 0, onConfirm: null },
  showLargePasteDialog: (charCount, onConfirm) =>
    set({ largePasteDialog: { open: true, charCount, onConfirm } }),
  closeLargePasteDialog: () =>
    set({ largePasteDialog: { open: false, charCount: 0, onConfirm: null } }),

  // Open-saved-file-in-tab confirmation
  openSavedFileDialog: { open: false, filePath: "" },
  showOpenSavedFileDialog: (filePath) => set({ openSavedFileDialog: { open: true, filePath } }),
  closeOpenSavedFileDialog: () => set({ openSavedFileDialog: { open: false, filePath: "" } }),

  // Export/Import dialogs
  exportDialogOpen: false,
  setExportDialogOpen: (open) => set({ exportDialogOpen: open }),
  importDialogOpen: false,
  importFileContent: undefined,
  setImportDialog: (open, content) => set({ importDialogOpen: open, importFileContent: content }),

  // Recovery warnings from corrupt config files
  recoveryWarnings: [],
  recoveryDialogOpen: false,
  setRecoveryDialogOpen: (open) => set({ recoveryDialogOpen: open }),
});
