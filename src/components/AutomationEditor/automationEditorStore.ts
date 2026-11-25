import { create } from "zustand";
import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import type { Automation } from "@/types/generated/Automation";

/** The automation the editor is open on, as it was when it opened. */
export interface EditedAutomation {
  automation: Automation;
  /** Not stored yet. */
  isNew: boolean;
}

/** Which automation the app-level editor is open on (#5818, slice 8). */
export interface AutomationEditorState {
  editing: EditedAutomation | null;
  /** Open the editor. Not while a recording goes into the one that is open. */
  open: (automation: Automation, isNew: boolean) => void;
  close: () => void;
  /**
   * The editor has stepped aside, with its draft, for the settings (A-031). A bar
   * above the terminals brings it back.
   */
  aside: boolean;
  setAside: (aside: boolean) => void;
}

/**
 * The open editor. Kept outside the sidebar that opens it: while "Record steps"
 * hides the editor, its draft must outlive a switch to another sidebar view.
 */
export const useAutomationEditor = create<AutomationEditorState>((set, get) => ({
  editing: null,
  open: (automation, isNew) => {
    if (get().editing && useAppStore.getState().recording?.intoEditor != null) {
      // toast-policy: explains-outcome — the editor does not open, and this says why
      toast.info("Stop the recording into the open automation first");
      return;
    }
    // Its draft is not lost to another automation.
    if (get().aside) set({ aside: false });
    else set({ editing: { automation, isNew } });
  },
  close: () => set({ editing: null, aside: false }),
  aside: false,
  setAside: (aside) => set({ aside }),
}));
