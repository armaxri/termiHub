import { useAppStore } from "@/store/appStore";
import { useProjectedConnections } from "@/store/useProjectedConnections";
import { useProjectedSettings } from "@/store/useProjectedSettings";
import { MobaxtermImportDialog } from "./MobaxtermImportDialog";

/**
 * App-level mount of the one-time MobaXterm import (#4850). Opened through the
 * store (`setMobaxtermImportOpen`) from Settings → Import & Migration or the
 * gear menu, so the dialog lives in one place and works from any window state.
 */
export function MobaxtermImportHost() {
  const open = useAppStore((s) => s.mobaxtermImportOpen);
  const setOpen = useAppStore((s) => s.setMobaxtermImportOpen);
  const importConnectionTree = useAppStore((s) => s.importConnectionTree);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const { folders, connections } = useProjectedConnections();
  const settings = useProjectedSettings();

  return (
    <MobaxtermImportDialog
      open={open}
      onOpenChange={setOpen}
      folders={folders}
      existingConnections={connections}
      onImport={importConnectionTree}
      settings={settings}
      onApplySettings={updateSettings}
    />
  );
}
