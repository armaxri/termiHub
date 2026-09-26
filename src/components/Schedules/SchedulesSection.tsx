import { useCallback, useState } from "react";
import { CalendarClock, Pencil, Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, StatusDot, Toggle, Tooltip, toast } from "@/components/ui";
import type { StatusTone } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarListItem } from "@/components/SidebarListItem";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import type { ScheduleRunOutcome, ScheduleView } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { formatAbsoluteTime, formatRelativeTime } from "@/utils/formatters";
import { describeRule, formatNextRun } from "./scheduleForm";
import { ScheduleEnableConfirmDialog } from "./ScheduleEnableConfirmDialog";
import { useScheduleLabels } from "./useScheduleLabels";
import "./Schedules.css";

/** Status-dot tone of a run outcome. */
function outcomeTone(outcome: ScheduleRunOutcome): StatusTone {
  switch (outcome) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
    case "skipped":
      return "warning";
  }
}

/** One-line status of a schedule: next run, running, paused, or disabled. */
function scheduleStatus(s: ScheduleView, paused: boolean): string {
  if (!s.enabled) return "Disabled";
  if (s.running) return "Running now";
  if (paused) return "Paused";
  return s.nextRunAt ? `Next: ${formatNextRun(s.nextRunAt)}` : "Not scheduled";
}

/**
 * The schedules list (PROD-043): every scheduled workflow/macro run with its
 * rule, targets, next run and last result; per-schedule enable (the first
 * enable asks for confirmation of the target hosts), edit and delete; and the
 * global pause switch. Lives in the Workflow sidebar.
 */
export function SchedulesSection() {
  const schedules = useAppStore((s) => s.schedules);
  const paused = useAppStore((s) => s.schedulesPaused);
  const setScheduleEnabled = useAppStore((s) => s.setScheduleEnabled);
  const setSchedulesPaused = useAppStore((s) => s.setSchedulesPaused);
  const deleteSchedule = useAppStore((s) => s.deleteSchedule);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const labels = useScheduleLabels();
  const [confirming, setConfirming] = useState<ScheduleView | null>(null);

  const scheduleDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id, name }) => {
    try {
      await deleteSchedule(id);
      toast.success(`Deleted schedule "${name}"`);
    } catch (err) {
      toast.error(`Failed to delete schedule: ${errorMessage(err)}`);
    }
  });

  const enable = useCallback(
    async (s: ScheduleView, enabled: boolean, confirmed: boolean) => {
      try {
        await setScheduleEnabled(s.id, enabled, confirmed);
        toast.success(`${enabled ? "Enabled" : "Disabled"} schedule "${s.name}"`);
      } catch (err) {
        toast.error(`Failed to update schedule: ${errorMessage(err)}`);
      }
    },
    [setScheduleEnabled]
  );

  const handleToggle = useCallback(
    (s: ScheduleView, enabled: boolean) => {
      // The first enable must be confirmed; later toggles need no prompt.
      if (enabled && !s.confirmedAt) setConfirming(s);
      else void enable(s, enabled, false);
    },
    [enable]
  );

  const handlePause = useCallback(
    async (next: boolean) => {
      try {
        await setSchedulesPaused(next);
        toast.success(next ? "Paused all schedules" : "Resumed schedules");
      } catch (err) {
        toast.error(`Failed to ${next ? "pause" : "resume"} schedules: ${errorMessage(err)}`);
      }
    },
    [setSchedulesPaused]
  );

  const confirmTargets = confirming ? labels.targets(confirming.targets) : null;

  return (
    <section className="schedules" data-testid="schedules-section" aria-label="Schedules">
      <header className="schedules__header">
        <span className="schedules__title">
          <CalendarClock size={12} aria-hidden="true" /> Schedules
        </span>
        <span className="schedules__header-actions">
          <label className="schedules__header-actions" htmlFor="schedules-pause-toggle">
            Pause all
            <Toggle
              id="schedules-pause-toggle"
              checked={paused}
              onCheckedChange={(v) => void handlePause(v)}
              aria-label="Pause all schedules"
              data-testid="schedules-pause-toggle"
            />
          </label>
          <Tooltip content="New schedule" side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="New schedule"
              data-testid="schedules-new-btn"
              icon={<Plus size={12} />}
              onClick={() => openScheduleEditor()}
            />
          </Tooltip>
        </span>
      </header>
      {schedules.length === 0 ? (
        <div className="schedules__empty" data-testid="schedules-empty">
          No schedules. Schedule a workflow or macro to run it on saved connections at set times.
        </div>
      ) : (
        <div className="schedules__list" data-testid="schedules-list">
          {schedules.map((s) => {
            const result = s.lastResult;
            return (
              <SidebarListItem
                key={s.id}
                testId={`schedule-item-${s.id}`}
                name={s.name}
                status={
                  result ? (
                    <StatusDot
                      tone={outcomeTone(result.outcome)}
                      label={`Last run ${result.outcome}`}
                      title={result.message ?? result.outcome}
                    />
                  ) : undefined
                }
                badge={scheduleStatus(s, paused)}
                badgeTestId={`schedule-status-${s.id}`}
                actions={
                  <>
                    <Toggle
                      checked={s.enabled}
                      onCheckedChange={(v) => handleToggle(s, v)}
                      aria-label={`${s.enabled ? "Disable" : "Enable"} schedule ${s.name}`}
                      data-testid={`schedule-enable-${s.id}`}
                    />
                    <Tooltip content="Edit" side="top">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Edit schedule"
                        data-testid={`schedule-edit-${s.id}`}
                        icon={<Pencil size={12} />}
                        onClick={() => openScheduleEditor({ scheduleId: s.id })}
                      />
                    </Tooltip>
                    <Tooltip content="Delete" side="top">
                      <Button
                        variant="ghost"
                        size="sm"
                        iconOnly
                        aria-label="Delete schedule"
                        data-testid={`schedule-delete-${s.id}`}
                        icon={<Trash2 size={12} />}
                        onClick={() => scheduleDelete.request({ id: s.id, name: s.name })}
                      />
                    </Tooltip>
                  </>
                }
                details={
                  <>
                    <span className="schedules__meta" data-testid={`schedule-summary-${s.id}`}>
                      {describeRule(s.rule)} · {labels.actionLabel(s.action)} on{" "}
                      {labels.targets(s.targets).label}
                    </span>
                    {result ? (
                      <span className="schedules__meta" data-testid={`schedule-last-${s.id}`}>
                        Last:{" "}
                        <time dateTime={result.at} title={formatAbsoluteTime(result.at)}>
                          {formatRelativeTime(result.at)}
                        </time>{" "}
                        · {result.outcome}
                        {result.catchUp ? " (catch-up)" : ""}
                        {result.message ? ` — ${result.message}` : ""}
                      </span>
                    ) : null}
                  </>
                }
              />
            );
          })}
        </div>
      )}
      <ScheduleEnableConfirmDialog
        open={confirming !== null}
        scheduleName={confirming?.name ?? ""}
        actionLabel={confirming ? labels.actionLabel(confirming.action) : ""}
        ruleLabel={confirming ? describeRule(confirming.rule) : ""}
        hosts={confirmTargets?.hosts ?? []}
        onConfirm={async () => {
          if (confirming) await enable(confirming, true, true);
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDeleteDialog
        {...scheduleDelete.dialogProps}
        message={scheduleDelete.pending ? `Delete schedule "${scheduleDelete.pending.name}"?` : ""}
      />
    </section>
  );
}
