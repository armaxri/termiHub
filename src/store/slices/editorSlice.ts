import { StateCreator } from "zustand";

import type { AppState } from "../appStore";
import type { EditorStatus, EditorActions } from "@/types/terminal";
import { vscodeAvailable as checkVscode } from "@/services/api";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";

/**
 * Editor-integration domain slice (ARCH-001/FES-011, appStore god-module split
 * via #2881): the file-editor / VS Code glue that is otherwise self-contained.
 *
 * Two cohesive pieces live here:
 * - **VS Code availability** — {@link vscodeAvailable} plus the background probe
 *   {@link checkVscodeAvailability} that asks the backend whether the `code` CLI
 *   is on `PATH`. The file browser's "Open in VS Code" affordances read the flag.
 * - **Editor status bar** — the {@link editorStatus} snapshot (cursor position,
 *   indentation, encoding, EOL, language) and the {@link editorActions} handles
 *   that the Monaco {@link FileEditor} publishes while focused, consumed by the
 *   status bar and the test-bridge caret verbs.
 *
 * Extracted verbatim from the monolithic root store as a behavior-preserving
 * Zustand slice — every action still receives the shared `set`/`get` typed
 * against the full {@link AppState}, so the public store shape and behavior are
 * unchanged. Mirrors the portable-mode / update-checker / etc. slices.
 */
export interface EditorSlice {
  // VS Code availability
  vscodeAvailable: boolean;
  checkVscodeAvailability: () => Promise<void>;

  // Editor status bar
  editorStatus: EditorStatus | null;
  setEditorStatus: (status: EditorStatus | null) => void;
  editorActions: EditorActions | null;
  setEditorActions: (actions: EditorActions | null) => void;
}

export const createEditorSlice: StateCreator<AppState, [], [], EditorSlice> = (set) => ({
  // VS Code availability
  vscodeAvailable: false,
  checkVscodeAvailability: async () => {
    try {
      const available = await checkVscode();
      set({ vscodeAvailable: available });
    } catch (err) {
      frontendLog("app_store", `Failed to check VS Code availability: ${errorMessage(err)}`);
    }
  },

  // Editor status bar
  editorStatus: null,
  setEditorStatus: (status) => set({ editorStatus: status }),
  editorActions: null,
  setEditorActions: (actions) => set({ editorActions: actions }),
});
