import { useCallback, useMemo } from "react";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import type { ScheduleInput } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { useScheduleLabels } from "./useScheduleLabels";

/**
 * App-level host of the schedule editor (PROD-043), so it can be opened from
 * the schedules list and from any workflow or macro row.
 */
export function ScheduleEditorHost() {
  const editor = useAppStore((s) => s.scheduleEditor);
  const schedules = useAppStore((s) => s.schedules);
  const saveSchedule = useAppStore((s) => s.saveSchedule);
  const closeScheduleEditor = useAppStore((s) => s.closeScheduleEditor);
  const { workflows, macros, connections, groups } = useScheduleLabels();

  const existing = editor?.scheduleId
    ? (schedules.find((s) => s.id === editor.scheduleId) ?? null)
    : null;
  const input: ScheduleInput | null = useMemo(
    () =>
      existing
        ? {
            id: existing.id,
            name: existing.name,
            action: existing.action,
            targets: existing.targets,
            rule: existing.rule,
            missedRuns: existing.missedRuns,
          }
        : null,
    [existing]
  );
  const scheduleId = existing?.id ?? editor?.draftId ?? "";

  const handleSave = useCallback(
    async (next: ScheduleInput) => {
      try {
        const saved = await saveSchedule(next);
        closeScheduleEditor();
        toast.success(`Saved schedule "${saved.name}"`, {
          description: saved.enabled
            ? undefined
            : "It is disabled — enable it in the Schedules list when you are ready.",
        });
      } catch (err) {
        toast.error(`Failed to save schedule: ${errorMessage(err)}`);
        throw err;
      }
    },
    [saveSchedule, closeScheduleEditor]
  );

  return (
    <ScheduleEditorDialog
      open={editor !== null}
      scheduleId={scheduleId}
      schedule={input}
      initialAction={editor?.action}
      workflows={workflows}
      macros={macros}
      connections={connections}
      groups={groups}
      onOpenChange={(open) => {
        if (!open) closeScheduleEditor();
      }}
      onSave={handleSave}
    />
  );
}
