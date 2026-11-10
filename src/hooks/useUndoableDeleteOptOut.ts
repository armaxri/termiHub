import { useCallback, useState } from "react";
import type { ConfirmDontAskAgain } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { currentSettingsView } from "@/store/settingsBridge";
import { useProjectedSettings } from "@/store/useProjectedSettings";

/** The label of the opt-out checkbox on an undoable delete's confirmation. */
export const UNDOABLE_DELETE_OPT_OUT_LABEL = "Don't ask again (you can still undo)";

/** State returned by {@link useUndoableDeleteOptOut}. */
export interface UndoableDeleteOptOut {
  /** False once the user opted out: delete straight away (the Undo toast stays). */
  shouldConfirm: boolean;
  /** Props for the confirm dialog's `dontAskAgain` slot. */
  dontAskAgain: ConfirmDontAskAgain;
  /**
   * Read and reset the checkbox. Returns true when the user ticked it, so the
   * caller persists `confirmUndoableDelete: false` together with the delete —
   * the opt-out applies only on Confirm, never on Cancel.
   */
  take: () => boolean;
  /** Reset the checkbox (on Cancel). */
  reset: () => void;
}

/**
 * The "don't ask again" opt-out shared by the deletes that offer an Undo toast
 * (connection folder, custom theme, idle tunnel — #5158). Backed by the
 * `confirmUndoableDelete` setting; `undefined` means confirm.
 */
export function useUndoableDeleteOptOut(): UndoableDeleteOptOut {
  const settings = useProjectedSettings();
  const [checked, setChecked] = useState(false);

  const take = useCallback(() => {
    const ticked = checked;
    setChecked(false);
    return ticked;
  }, [checked]);
  const reset = useCallback(() => setChecked(false), []);

  return {
    shouldConfirm: settings.confirmUndoableDelete !== false,
    dontAskAgain: {
      checked,
      onChange: setChecked,
      label: UNDOABLE_DELETE_OPT_OUT_LABEL,
    },
    take,
    reset,
  };
}

/**
 * Persist the opt-out from outside the Settings screen (the sidebars): stop
 * confirming undoable deletes. Re-enable it under Settings → Safety prompts.
 */
export function persistUndoableDeleteOptOut(): void {
  void useAppStore
    .getState()
    .updateSettings({ ...currentSettingsView(), confirmUndoableDelete: false });
}
