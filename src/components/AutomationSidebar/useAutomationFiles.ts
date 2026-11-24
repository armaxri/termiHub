import { useCallback } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { useJsonFileExport, useJsonFileImport } from "@/hooks/useJsonFile";
import { inspectAutomationFile, serializeAutomationLibrary } from "@/services/automationFileIo";
import { serializeMacros } from "@/services/macroIo";
import { serializeWorkflows, type WorkflowImportResult } from "@/services/workflowIo";
import { slugify } from "@/utils/slugify";

/** What an import needs the user to look at before running it; empty when nothing. */
export function importWarnings(result: WorkflowImportResult): string[] {
  const warnings: string[] = [];
  if (result.localProcessSteps > 0) {
    // Security surfacing (#1856): an imported automation may carry a
    // run-local-process step. It is preserved but NOT auto-authorized — the
    // runner refuses to spawn it until it is explicitly enabled (#1857).
    const steps = `${result.localProcessSteps} local-process step${
      result.localProcessSteps === 1 ? "" : "s"
    }`;
    const automations = `${result.workflowsWithLocalProcess} imported automation${
      result.workflowsWithLocalProcess === 1 ? "" : "s"
    }`;
    warnings.push(
      `${automations} contain ${steps} that run a local program. These stay disabled and will not run until you review and authorize them.`
    );
  }
  const removed = result.removedScriptSourcePaths;
  if (removed.length > 0) {
    // Security surfacing (#4310, FEC2-001): an imported run-script step
    // referenced a local file to read and type into the remote shell. The
    // reference was removed on import; name the real paths so the user can
    // see what the file tried to read and re-pick a file deliberately.
    const steps = `${removed.length} run-script step${removed.length === 1 ? "" : "s"}`;
    const verb = removed.length === 1 ? "referenced a local file" : "referenced local files";
    warnings.push(
      `${steps} ${verb} (${removed.join(", ")}). The untrusted file reference was removed, so only the visible script runs. Re-pick the file in the step editor to load it from disk.`
    );
  }
  return warnings;
}

/** The sidebar's file actions. */
export interface AutomationFiles {
  /** Export the whole library to one file. */
  exportAll: () => void;
  /** Export one automation to a file. */
  exportOne: (automationId: string) => void;
  /** Import a file with either legacy list, or both. */
  importFile: () => void;
}

/**
 * Import and export of automations (#5818, slice 6): one Import that reads any
 * file the two old sidebars wrote, and one Export all for the whole library.
 */
export function useAutomationFiles(): AutomationFiles {
  const macros = useAppStore((s) => s.macros);
  const workflows = useAppStore((s) => s.workflows);
  const importMacros = useAppStore((s) => s.importMacros);
  const importWorkflows = useAppStore((s) => s.importWorkflows);
  const exportToFile = useJsonFileExport("automations");
  const importFromFile = useJsonFileImport("automations");

  const exportAll = useCallback(() => {
    const count = macros.length + workflows.length;
    void exportToFile({
      defaultPath: "termihub-automations.json",
      content: () => serializeAutomationLibrary({ macros, workflows }),
      successMessage: `Exported ${count} automation${count === 1 ? "" : "s"}`,
    });
  }, [macros, workflows, exportToFile]);

  const exportOne = useCallback(
    (automationId: string) => {
      const macro = macros.find((m) => m.id === automationId);
      const workflow = workflows.find((w) => w.id === automationId);
      const name = macro?.name ?? workflow?.name;
      if (name === undefined) return;
      void exportToFile({
        defaultPath: `termihub-automation-${slugify(name, "automation")}.json`,
        content: () =>
          macro ? serializeMacros([macro]) : serializeWorkflows(workflow ? [workflow] : []),
        successMessage: `Exported "${name}"`,
      });
    },
    [macros, workflows, exportToFile]
  );

  const importFile = useCallback(() => {
    void importFromFile(async (json) => {
      // The whole file is checked before anything is saved.
      const lists = inspectAutomationFile(json);
      const typed = lists.macros ? await importMacros(json) : 0;
      if (!lists.workflows) return;
      const result = await importWorkflows(json);
      // The imported rows show in the list (#5859); only warnings need a toast.
      const warnings = importWarnings(result);
      if (warnings.length === 0) return;
      const count = typed + result.imported;
      // Flag it prominently (persistent toast) so it is never silently trusted.
      // toast-policy: explains-outcome — the rows do not show what needs a second look
      toast.info(`Imported ${count} automation${count === 1 ? "" : "s"}`, {
        description: warnings.join(" "),
        duration: Infinity,
      });
    });
  }, [importFromFile, importMacros, importWorkflows]);

  return { exportAll, exportOne, importFile };
}
