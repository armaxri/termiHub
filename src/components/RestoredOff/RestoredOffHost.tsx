import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MAIN_WINDOW_LABEL } from "@/types/window";
import { useAppStore } from "@/store/appStore";
import { RestoredOffDialog } from "./RestoredOffDialog";
import { useRestoredOff } from "./useRestoredOff";

/**
 * Asks once per start, in the main window, about what a restore left switched off
 * (#6056). It waits for the dialogs that a start may need first.
 */
export function RestoredOffHost() {
  const { entries, setEntries } = useRestoredOff(getCurrentWindow().label === MAIN_WINDOW_LABEL);
  const [later, setLater] = useState(false);
  const busy = useAppStore((s) => s.unlockDialogOpen || s.recoveryDialogOpen);
  if (entries.length === 0) return null;
  return (
    <RestoredOffDialog
      open={!later && !busy}
      entries={entries}
      onLater={() => setLater(true)}
      onDone={setEntries}
    />
  );
}
