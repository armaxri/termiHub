import { useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui";
import { AutomationImportDialog } from "@/components/Automations/AutomationImportDialog";
import { useAutomationFiles } from "@/components/Automations/useAutomationFiles";
import type { AutomationImport } from "@/services/automationFileIo";
import { useAppStore } from "@/store/appStore";
import { SettingsSectionHeading } from "./SettingsSectionHeading";

/** Settings → Import & migration → automations (#5818, slice 11). */
export function AutomationFileSettings() {
  const empty = useAppStore((s) => s.automations.length === 0);
  const files = useAutomationFiles();
  const [imported, setImported] = useState<AutomationImport | null>(null);

  const showInSidebar = () => {
    setImported(null);
    // Selecting the view that already shows would close the sidebar.
    const { sidebarView, sidebarCollapsed, setSidebarView } = useAppStore.getState();
    if (sidebarView !== "automations" || sidebarCollapsed) setSidebarView("automations");
  };

  return (
    <section className="import-migration__group" data-testid="import-migration-automations">
      <SettingsSectionHeading>Import / export automations</SettingsSectionHeading>
      <p className="settings-panel__description">
        Move automations between termiHub installs as a JSON file. Macro and workflow files of older
        versions can be imported too.
      </p>
      <div className="credential-vault__actions">
        <Button
          variant="secondary"
          size="sm"
          icon={<Upload size={14} />}
          onClick={() => files.importFile(setImported)}
          data-testid="import-migration-automations-import-btn"
        >
          Import automations…
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Download size={14} />}
          onClick={files.exportAll}
          disabled={empty}
          data-testid="import-migration-automations-export-btn"
        >
          Export all automations…
        </Button>
      </div>
      <AutomationImportDialog
        result={imported}
        onClose={() => setImported(null)}
        onShow={showInSidebar}
      />
    </section>
  );
}
