import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CalendarClock, Pause, Play, Plus } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, StatusDot, Tooltip, toast, EmptyState } from "@/components/ui";
import { ConfirmDeleteDialog } from "@/components/Sidebar/ConfirmDeleteDialog";
import { AUTOMATION_JUST_SAVED_MS } from "@/components/AutomationSidebar/AutomationRow";
import {
  showHistoryInSidebar,
  useAutomationSections,
} from "@/components/AutomationSidebar/automationSections";
import { SidebarSectionHeader } from "@/components/Sidebar/SidebarSectionHeader";
import { useElementWidth } from "@/hooks/useElementWidth";
import { useDeleteConfirm } from "@/hooks/useDeleteConfirm";
import type { ScheduleView } from "@/types/schedule";
import { errorMessage } from "@/utils/errorMessage";
import { t } from "@/i18n/catalog";
import { ScheduleEnableConfirmDialog } from "./ScheduleEnableConfirmDialog";
import { ScheduleRow } from "./ScheduleRow";
import { lastRunAttention } from "./scheduleStatus";
import { useScheduleLabels } from "./useScheduleLabels";
import "./Schedules.css";

/**
 * Header content width (px) below which the "Pause all" text label is dropped
 * and the toggle explains itself through a tooltip (#4709): the title, the
 * label, the toggle and the "+" no longer fit on one line under it.
 */
export const SCHEDULES_HEADER_COMPACT_WIDTH = 220;

/**
 * The schedules list (PROD-043): one {@link ScheduleRow} per schedule, with its
 * switch (the first time it is switched on asks for confirmation of the target
 * hosts), edit and delete, and the global pause switch. What ran, and what did
 * not, is in the one History (#6024). Lives in the Automations sidebar, where it collapses to
 * its header (#5818), and in Settings → Schedules (#4623).
 */
export interface SchedulesSectionProps {
  /**
   * Render the "Schedules" section header (default `true`). A page that already
   * titles itself "Schedules" passes `false` and gets a plain toolbar instead,
   * so the title is not repeated (#5633).
   */
  showTitle?: boolean;
  /** Make the titled section collapsible (#5818); absent = always open. */
  collapse?: { expanded: boolean; onChange: (expanded: boolean) => void };
}

/** Renders the schedules list; see the module notes above. */
export function SchedulesSection({ showTitle = true, collapse }: SchedulesSectionProps) {
  const contentId = useId();
  const open = collapse?.expanded ?? true;
  const schedules = useAppStore((s) => s.schedules);
  const paused = useAppStore((s) => s.schedulesPaused);
  const setScheduleEnabled = useAppStore((s) => s.setScheduleEnabled);
  const setSchedulesPaused = useAppStore((s) => s.setSchedulesPaused);
  const deleteSchedule = useAppStore((s) => s.deleteSchedule);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const labels = useScheduleLabels();
  const [confirming, setConfirming] = useState<ScheduleView | null>(null);
  const [headerRef, headerWidth] = useElementWidth<HTMLElement>();
  const compactHeader = headerWidth !== null && headerWidth < SCHEDULES_HEADER_COMPACT_WIDTH;

  const scheduleDelete = useDeleteConfirm<{ id: string; name: string }>(async ({ id }) => {
    try {
      await deleteSchedule(id);
    } catch (err) {
      toast.error(`Failed to delete schedule: ${errorMessage(err)}`);
    }
  });

  const enable = useCallback(
    async (s: ScheduleView, enabled: boolean, confirmed: boolean) => {
      try {
        await setScheduleEnabled(s.id, enabled, confirmed);
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
      } catch (err) {
        toast.error(`Failed to ${next ? "pause" : "resume"} schedules: ${errorMessage(err)}`);
      }
    },
    [setSchedulesPaused]
  );

  // The schedule just saved: its row is tinted and brought into view, so the
  // user sees at once whether it is on (#6024).
  const saved = useAutomationSections((s) => s.savedSchedule);
  const [unmarkedSeq, setUnmarkedSeq] = useState(saved?.seq ?? 0);
  const justSaved = saved && saved.seq > unmarkedSeq ? saved : null;
  const listRef = useRef<HTMLDivElement>(null);
  const rowExists = justSaved !== null && schedules.some((s) => s.id === justSaved.id);
  useEffect(() => {
    if (!justSaved || !rowExists || !open) return;
    const rowTestId = `schedule-item-${justSaved.id}`;
    Array.from(listRef.current?.children ?? [])
      .find((row) => row.getAttribute("data-testid") === rowTestId)
      ?.scrollIntoView?.({ block: "nearest" });
    const timer = window.setTimeout(() => setUnmarkedSeq(justSaved.seq), AUTOMATION_JUST_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved, rowExists, open]);

  const confirmTargets = confirming ? labels.targets(confirming.targets) : null;

  // A verb, not a switch (A-019): an "off" switch beside "Schedules" read as if
  // the schedules were off.
  const pauseLabel = paused ? "Resume all schedules" : "Pause all schedules";
  // There is nothing to pause without a schedule (R-135); a pause left on stays
  // reachable.
  const pauseToggle =
    schedules.length === 0 && !paused ? null : (
      <Tooltip content={pauseLabel} side="top" disabled={!compactHeader}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly={compactHeader}
          icon={paused ? <Play size={12} /> : <Pause size={12} />}
          aria-label={pauseLabel}
          onClick={() => handlePause(!paused)}
          data-paused={paused ? "true" : "false"}
          data-testid="schedules-pause-toggle"
        >
          {compactHeader ? null : paused ? "Resume" : "Pause all"}
        </Button>
      </Tooltip>
    );

  // A closed section must not hide a schedule that needs attention.
  const concerns = schedules.map(lastRunAttention);
  const concern = concerns.includes("error") ? "error" : concerns.find(Boolean);
  const openNew = () => {
    collapse?.onChange(true);
    openScheduleEditor();
  };

  return (
    <section
      className={`schedules ${showTitle ? "" : "schedules--page"}`}
      data-testid="schedules-section"
      aria-label="Schedules"
    >
      {showTitle ? (
        <SidebarSectionHeader
          ref={headerRef}
          title="Schedules"
          icon={<CalendarClock size={12} aria-hidden="true" />}
          suffix={
            [
              collapse && schedules.length > 0 ? ` (${schedules.length})` : "",
              paused ? ` · ${t("schedule.state.paused")}` : "",
            ].join("") || undefined
          }
          collapse={
            collapse
              ? {
                  expanded: open,
                  onToggle: () => collapse.onChange(!open),
                  controls: contentId,
                  testId: "schedules-section-toggle",
                }
              : undefined
          }
          data-testid="schedules-header"
          actions={
            <>
              {!open && concern ? (
                <StatusDot
                  tone={concern}
                  label={t(
                    concern === "error" ? "schedule.marker.lastFailed" : "schedule.marker.attention"
                  )}
                  testId="schedules-failed-dot"
                />
              ) : null}
              {pauseToggle}

              <Tooltip content="New schedule" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="New schedule"
                  data-testid="schedules-new-btn"
                  icon={<Plus size={12} />}
                  onClick={openNew}
                />
              </Tooltip>
            </>
          }
        />
      ) : (
        <div className="schedules__toolbar" data-testid="schedules-toolbar">
          {schedules.length > 0 ? (
            <Button
              variant="secondary"
              size="sm"
              data-testid="schedules-new-btn"
              icon={<Plus size={12} />}
              onClick={() => openScheduleEditor()}
            >
              New schedule
            </Button>
          ) : null}
          {pauseToggle}
        </div>
      )}
      {!open ? null : schedules.length === 0 ? (
        <div id={contentId}>
          <EmptyState
            title="No schedules yet"
            description="Schedule an automation to run it on saved connections at set times."
            action={
              <Button
                variant="secondary"
                size="sm"
                data-testid="schedules-empty-new-btn"
                icon={<Plus size={12} />}
                onClick={() => openScheduleEditor()}
              >
                New schedule
              </Button>
            }
            data-testid="schedules-empty"
          />
        </div>
      ) : (
        <div ref={listRef} id={contentId} className="schedules__list" data-testid="schedules-list">
          {schedules.map((s) => (
            <ScheduleRow
              key={s.id}
              schedule={s}
              paused={paused}
              action={labels.actionLabel(s.action)}
              targets={labels.targets(s.targets).label}
              blocked={labels.blockedReason(s)}
              justSaved={justSaved?.id === s.id}
              onToggle={(next) => handleToggle(s, next)}
              onEdit={() => openScheduleEditor({ scheduleId: s.id })}
              onShowHistory={() => showHistoryInSidebar(s.action.automationId)}
              onDelete={() => scheduleDelete.request({ id: s.id, name: s.name })}
            />
          ))}
        </div>
      )}
      <ScheduleEnableConfirmDialog
        open={confirming !== null}
        scheduleName={confirming?.name ?? ""}
        actionLabel={confirming ? labels.actionLabel(confirming.action) : ""}
        rule={confirming?.rule ?? null}
        hosts={confirmTargets?.hosts ?? []}
        gone={confirmTargets?.gone ?? null}
        connects={confirming?.connectIfNeeded === true}
        onConfirm={async () => {
          if (confirming) await enable(confirming, true, true);
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDeleteDialog
        {...scheduleDelete.dialogProps}
        message={scheduleDelete.pending ? `Delete schedule “${scheduleDelete.pending.name}”?` : ""}
      />
    </section>
  );
}
