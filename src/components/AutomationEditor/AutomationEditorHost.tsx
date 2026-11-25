import { useCallback, useMemo, useState } from "react";
import { RunTargetsDialog } from "@/components/Automations/RunTargetsDialog";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { toast } from "@/components/ui";
import { getActiveTab, useAppStore } from "@/store/appStore";
import { errorMessage } from "@/utils/errorMessage";
import { AutomationEditorDialog, type AutomationSaveRequest } from "./AutomationEditorDialog";
import { useAutomationEditor } from "./automationEditorStore";

/**
 * App-level host of the automation editor (#5818, slice 8): it stores what the
 * editor saves, then runs or schedules it when asked to.
 */
export function AutomationEditorHost() {
  const editing = useAutomationEditor((s) => s.editing);
  const close = useAutomationEditor((s) => s.close);
  const automations = useAppStore((s) => s.automations);
  const saveAutomation = useAppStore((s) => s.saveAutomationToBackend);
  const runAutomation = useAppStore((s) => s.runAutomation);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  // "Save and run" without an active terminal asks where, as the row's Run does.
  const [runOnId, setRunOnId] = useState<string | null>(null);
  const runOnItems = useMemo(() => {
    const automation = automations.find((a) => a.id === runOnId);
    return automation
      ? [{ id: automation.id, name: automation.name, stepCount: automation.steps.length }]
      : [];
  }, [automations, runOnId]);

  const save = useCallback(
    async ({ automation, run, schedule }: AutomationSaveRequest) => {
      const id = useAutomationEditor.getState().editing?.automation.id;
      if (!id) return;
      if (automation) {
        try {
          await saveAutomation(automation);
        } catch (err) {
          // Keep the dialog open so the edits are not lost on a failed save.
          toast.error(`Failed to save automation: ${errorMessage(err)}`);
          throw err;
        }
      }
      close();
      if (automation) useAutomationSections.getState().markSaved(id);
      if (run) {
        if (getActiveTab(useAppStore.getState())?.contentType === "terminal") {
          void runAutomation(id);
        } else {
          setRunOnId(id);
        }
      }
      if (schedule) openScheduleEditor({ action: { kind: "automation", automationId: id } });
    },
    [close, saveAutomation, runAutomation, openScheduleEditor]
  );

  return (
    <>
      {editing && (
        <AutomationEditorDialog
          key={editing.automation.id}
          automation={editing.automation}
          isNew={editing.isNew}
          onClose={close}
          onSave={save}
        />
      )}
      <RunTargetsDialog
        open={runOnId !== null}
        automations={runOnItems}
        emptyText="This automation no longer exists."
        onOpenChange={(open) => {
          if (!open) setRunOnId(null);
        }}
        onRun={(id, targetTabIds, { parallel }) =>
          void runAutomation(id, { targetTabIds, parallel })
        }
      />
    </>
  );
}
