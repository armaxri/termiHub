import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import {
  serializeAutomations,
  withCalledAutomations,
  type AutomationImport,
} from "@/services/automationFileIo";
import { slugify } from "@/utils/slugify";

/** The file actions of automations. */
export interface AutomationFiles {
  /** Export the whole library to one file. */
  exportAll: () => void;
  /** Export one automation, and the ones it runs, to a file. */
  exportOne: (automationId: string) => void;
  /** Import a file of this or an older build, and report what came in. */
  importFile: (onImported: (result: AutomationImport) => void) => void;
}

/** Import and export of automations (#5818, slice 11). */
export function useAutomationFiles(): AutomationFiles {
  const automations = useAppStore((s) => s.automations);
  const importAutomations = useAppStore((s) => s.importAutomations);
  const exportToFile = useJsonFileExport("automations");
  const importFromFile = useJsonFileImport("automations");

  const exportAll = useCallback(() => {
    const count = automations.length;
    void exportToFile({
      defaultPath: "termihub-automations.json",
      content: () => serializeAutomations(automations),
      successMessage: `Exported ${count} automation${count === 1 ? "" : "s"}`,
    });
  }, [automations, exportToFile]);

  const exportOne = useCallback(
    (automationId: string) => {
      const automation = automations.find((a) => a.id === automationId);
      if (!automation) return;
      const exported = withCalledAutomations(automation, automations);
      const called = exported.length - 1;
      const extra =
        called === 0
          ? ""
          : ` and the ${called === 1 ? "automation" : `${called} automations`} it runs`;
      void exportToFile({
        defaultPath: `termihub-automation-${slugify(automation.name, "automation")}.json`,
        content: () => serializeAutomations(exported),
        successMessage: `Exported "${automation.name}"${extra}`,
      });
    },
    [automations, exportToFile]
  );

  const importFile = useCallback(
    (onImported: (result: AutomationImport) => void) => {
      void importFromFile(async (json) => onImported(await importAutomations(json)));
    },
    [importFromFile, importAutomations]
  );

  return { exportAll, exportOne, importFile };
}
