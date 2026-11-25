import { useCallback, useMemo } from "react";
import { useAppStore } from "@/store/appStore";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { toast } from "@/components/ui";
import type { ScheduleInput, ScheduleRule } from "@/types/schedule";
import { t, tf } from "@/i18n/catalog";
import { previewScheduleNextRun } from "@/services/scheduleApi";
import { errorMessage } from "@/utils/errorMessage";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { useScheduleLabels } from "./useScheduleLabels";

/**
 * App-level host of the schedule editor (PROD-043), so it can be opened from
 * the schedules list and from any automation row.
 */
export function ScheduleEditorHost() {
  const editor = useAppStore((s) => s.scheduleEditor);
  const schedules = useAppStore((s) => s.schedules);
  const saveSchedule = useAppStore((s) => s.saveSchedule);
  const closeScheduleEditor = useAppStore((s) => s.closeScheduleEditor);
  const { automations, connections, groups } = useScheduleLabels();

  const existing = editor?.scheduleId
    ? (schedules.find((s) => s.id === editor.scheduleId) ?? null)
    : null;
  const input: ScheduleInput | null = useMemo(
    () =>
      existing
        ? // Every editable field (#5983): one the editor is not given is lost on
          // save. The type names them all, so a new field fails to compile here.
          ({
            id: existing.id,
            name: existing.name,
            description: existing.description,
            action: existing.action,
            targets: existing.targets,
            rule: existing.rule,
            missedRuns: existing.missedRuns,
            connectIfNeeded: existing.connectIfNeeded,
          } satisfies { [K in keyof Required<ScheduleInput>]: ScheduleInput[K] })
        : null,
    [existing]
  );
  const paused = useAppStore((s) => s.schedulesPaused);
  const existingId = existing?.id ?? null;
  const preview = useCallback(
    (rule: ScheduleRule) => previewScheduleNextRun(existingId, rule),
    [existingId]
  );
  const scheduleId = existing?.id ?? editor?.draftId ?? "";

  const handleSave = useCallback(
    async (next: ScheduleInput) => {
      try {
        const saved = await saveSchedule(next);
        closeScheduleEditor();
        const sections = useAutomationSections.getState();
        sections.setSchedulesOpen(true);
        sections.markScheduleSaved(saved.id);
        // The saved row shows in the Schedules list (#5859). One that is off
        // will not run, which the user must know after saving it.
        if (!saved.enabled) {
          // After the editor closed: its own status line would take the message
          // with it.
          window.setTimeout(() => {
            // toast-policy: explains-outcome — the schedule was saved but will not run yet
            toast.info(tf("schedule.saved.off", { name: saved.name }), {
              description: t("schedule.saved.offHint"),
            });
          }, 0);
        }
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
      automations={automations}
      connections={connections}
      groups={groups}
      enabled={existing?.enabled === true}
      paused={paused}
      previewNextRun={preview}
      onOpenChange={(open) => {
        if (!open) closeScheduleEditor();
      }}
      onSave={handleSave}
    />
  );
}
