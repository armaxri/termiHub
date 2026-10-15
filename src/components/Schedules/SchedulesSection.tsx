import { useCallback, useState } from "react";
import { CalendarClock, ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, StatusDot, Toggle, Tooltip, toast, EmptyState } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { SidebarListItem } from "@/components/SidebarListItem";
import { SidebarSectionHeader } from "@/components/Sidebar/SidebarSectionHeader";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import type { ScheduleView } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { formatAbsoluteTime, formatRelativeTime } from "@/utils/formatters";
import { describeRule, formatNextRun } from "./scheduleForm";
import { outcomeTone, ScheduleAttemptHistory } from "./ScheduleAttemptHistory";
import { ScheduleEnableConfirmDialog } from "./ScheduleEnableConfirmDialog";
import { useScheduleLabels } from "./useScheduleLabels";
import "./Schedules.css";

/**
 * Header content width (px) below which the "Pause all" text label is dropped
 * and the toggle explains itself through a tooltip (#4709): the title, the
 * label, the toggle and the "+" no longer fit on one line under it.
 */
export const SCHEDULES_HEADER_COMPACT_WIDTH = 220;

/** One-line status of a schedule: next run, running, paused, or disabled. */
function scheduleStatus(s: ScheduleView, paused: boolean): string {
  if (!s.enabled) return "Disabled";
  if (s.running) return "Running now";
  if (paused) return "Paused";
  return s.nextRunAt ? `Next: ${formatNextRun(s.nextRunAt)}` : "Not scheduled";
}

/**
 * The schedules list (PROD-043): every scheduled workflow/macro run with its
 * rule, targets, next run and last result — expandable to its recent attempts
 * (#3528); per-schedule enable (the first
 * enable asks for confirmation of the target hosts), edit and delete; and the
 * global pause switch. Lives in the Workflow sidebar, and in Settings →
 * Schedules (#4623), which is reachable with experimental features off.
 */
export interface SchedulesSectionProps {
  /**
   * Show the create/edit actions (default `true`). The Settings panel passes
   * `false`: it only views, pauses/resumes and deletes schedules (#4623).
   */
  editable?: boolean;
}

/** Renders the schedules list; see the module notes above. */
export function SchedulesSection({ editable = true }: SchedulesSectionProps) {
  const schedules = useAppStore((s) => s.schedules);
  const paused = useAppStore((s) => s.schedulesPaused);
  const setScheduleEnabled = useAppStore((s) => s.setScheduleEnabled);
  const setSchedulesPaused = useAppStore((s) => s.setSchedulesPaused);
  const deleteSchedule = useAppStore((s) => s.deleteSchedule);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const labels = useScheduleLabels();
  const [confirming, setConfirming] = useState<ScheduleView | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [headerRef, headerWidth] = useElementWidth<HTMLElement>();
  const compactHeader = headerWidth !== null && headerWidth < SCHEDULES_HEADER_COMPACT_WIDTH;

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

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
      <SidebarSectionHeader
        ref={headerRef}
        title="Schedules"
        icon={<CalendarClock size={12} aria-hidden="true" />}
        data-testid="schedules-header"
        actions={
          <>
            <Tooltip content="Pause all schedules" side="top" disabled={!compactHeader}>
              <label className="schedules__pause" htmlFor="schedules-pause-toggle">
                {compactHeader ? null : <span>Pause all</span>}
                <Toggle
                  id="schedules-pause-toggle"
                  checked={paused}
                  onCheckedChange={(v) => void handlePause(v)}
                  aria-label="Pause all schedules"
                  data-testid="schedules-pause-toggle"
                />
              </label>
            </Tooltip>
            {editable ? (
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
            ) : null}
          </>
        }
      />
      {schedules.length === 0 ? (
        <EmptyState
          title="No schedules. Schedule a workflow or macro to run it on saved connections at set times."
          data-testid="schedules-empty"
        />
      ) : (
        <div className="schedules__list" data-testid="schedules-list">
          {schedules.map((s) => {
            const result = s.lastResult;
            const attempts = s.history ?? [];
            const open = expanded.has(s.id);
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
                    {editable ? (
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
                    ) : null}
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
                    {attempts.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="schedules__attempts-toggle"
                        aria-expanded={open}
                        data-testid={`schedule-attempts-toggle-${s.id}`}
                        icon={open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        onClick={() => toggleExpanded(s.id)}
                      >
                        {open ? "Hide" : "Show"} recent attempts ({attempts.length})
                      </Button>
                    ) : null}
                    {open && attempts.length > 0 ? (
                      <ScheduleAttemptHistory scheduleId={s.id} attempts={attempts} />
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
        connects={confirming?.connectIfNeeded === true}
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
