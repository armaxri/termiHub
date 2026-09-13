import { describe, it, expect, beforeEach, vi } from "vitest";
import { create, type StateCreator } from "zustand";

import type { RecoveryWarning } from "@/types/connection";

import { createDialogsSlice, type DialogsSlice } from "./dialogsSlice";

// The dialogs slice is a pure set of runtime-only open/close reducers with no
// `@/services` deps, so a standalone zustand store exercises its real semantics.
const makeStore = () =>
  create<DialogsSlice>()(createDialogsSlice as unknown as StateCreator<DialogsSlice>);

describe("dialogsSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  it("defaults every dialog to closed", () => {
    const s = store.getState();
    expect(s.largePasteDialog).toEqual({ open: false, charCount: 0, onConfirm: null });
    expect(s.openSavedFileDialog).toEqual({ open: false, filePath: "" });
    expect(s.exportDialogOpen).toBe(false);
    expect(s.importDialogOpen).toBe(false);
    expect(s.importFileContent).toBeUndefined();
    expect(s.recoveryWarnings).toEqual([]);
    expect(s.recoveryDialogOpen).toBe(false);
  });

  it("opens and closes the large-paste dialog, keeping the confirm callback", () => {
    const onConfirm = vi.fn();
    store.getState().showLargePasteDialog(1234, onConfirm);
    expect(store.getState().largePasteDialog).toEqual({
      open: true,
      charCount: 1234,
      onConfirm,
    });
    store.getState().closeLargePasteDialog();
    expect(store.getState().largePasteDialog).toEqual({
      open: false,
      charCount: 0,
      onConfirm: null,
    });
  });

  it("opens and closes the open-saved-file dialog", () => {
    store.getState().showOpenSavedFileDialog("/tmp/out.log");
    expect(store.getState().openSavedFileDialog).toEqual({ open: true, filePath: "/tmp/out.log" });
    store.getState().closeOpenSavedFileDialog();
    expect(store.getState().openSavedFileDialog).toEqual({ open: false, filePath: "" });
  });

  it("toggles the export dialog", () => {
    store.getState().setExportDialogOpen(true);
    expect(store.getState().exportDialogOpen).toBe(true);
    store.getState().setExportDialogOpen(false);
    expect(store.getState().exportDialogOpen).toBe(false);
  });

  it("sets the import dialog with and without content", () => {
    store.getState().setImportDialog(true, '{"a":1}');
    expect(store.getState().importDialogOpen).toBe(true);
    expect(store.getState().importFileContent).toBe('{"a":1}');
    // Closing without content clears the pending payload.
    store.getState().setImportDialog(false);
    expect(store.getState().importDialogOpen).toBe(false);
    expect(store.getState().importFileContent).toBeUndefined();
  });

  it("toggles the recovery dialog without touching the warnings list", () => {
    const warnings: RecoveryWarning[] = [
      { fileName: "connections.json", message: "corrupt entry skipped", details: null },
    ];
    store.setState({ recoveryWarnings: warnings });
    store.getState().setRecoveryDialogOpen(true);
    expect(store.getState().recoveryDialogOpen).toBe(true);
    expect(store.getState().recoveryWarnings).toBe(warnings);
    store.getState().setRecoveryDialogOpen(false);
    expect(store.getState().recoveryDialogOpen).toBe(false);
  });
});
