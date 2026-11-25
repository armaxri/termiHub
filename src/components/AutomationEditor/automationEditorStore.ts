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
  /** Open the editor, unless it is open on another automation. */
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
    else if (!get().editing) set({ editing: { automation, isNew } });
    // A failed run's toast can ask for another one while an editor is open (#6026).
    else if (get().editing?.automation.id !== automation.id)
      // toast-policy: explains-outcome — the editor does not open, and this says why
      toast.info("Save or close the open automation first");
  },
  close: () => set({ editing: null, aside: false }),
  aside: false,
  setAside: (aside) => set({ aside }),
}));
