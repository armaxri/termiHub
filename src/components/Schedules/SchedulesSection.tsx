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
import { ScheduleRow } from "./ScheduleRow";
import { ScheduleSwitchOn } from "./ScheduleSwitchOn";
import { concernText, lastRunAttention } from "./scheduleStatus";
import { useScheduleLabels } from "./useScheduleLabels";
import { ICON_SIZE } from "@/components/ui/iconSize";
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
    async (s: ScheduleView, enabled: boolean) => {
      try {
        await setScheduleEnabled(s.id, enabled, false);
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
      else void enable(s, enabled);
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

  // Opened from Settings or the status bar: the section takes the focus and is
  // marked for a moment, so the user sees what changed (#5860, G-009).
  const revealed = useAutomationSections((s) => s.schedulesRevealed);
  const [shownReveal, setShownReveal] = useState(revealed);
  const revealing = collapse !== undefined && revealed > shownReveal;
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!revealing || !open) return;
    sectionRef.current?.scrollIntoView?.({ block: "nearest" });
    sectionRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setShownReveal(revealed), AUTOMATION_JUST_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [revealing, open, revealed]);

  // Neither a closed section nor the fold hides a schedule that needs attention.
  const concerns = schedules.map(lastRunAttention);
  const failed = concerns.filter((c) => c === "error").length;
  const notRun = concerns.filter((c) => c === "warning").length;
  const count = collapse && schedules.length > 0 ? ` (${schedules.length})` : "";
  const suffix = paused ? ` · ${t("schedule.state.paused")}` : count;
  const concern = concernText(failed, notRun);
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
          icon={paused ? <Play size={ICON_SIZE.xs} /> : <Pause size={ICON_SIZE.xs} />}
          aria-label={pauseLabel}
          onClick={() => handlePause(!paused)}
          data-paused={paused ? "true" : "false"}
          data-testid="schedules-pause-toggle"
        >
          {compactHeader ? null : paused ? "Resume" : "Pause all"}
        </Button>
      </Tooltip>
    );

  const openNew = () => {
    collapse?.onChange(true);
    openScheduleEditor();
  };

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className={`schedules ${showTitle ? "" : "schedules--page"} ${revealing && open ? "schedules--revealed" : ""}`}
      data-open={open ? "true" : "false"}
      data-revealed={revealing && open ? "true" : undefined}
      data-testid="schedules-section"
      aria-label="Schedules"
    >
      {showTitle ? (
        <SidebarSectionHeader
          ref={headerRef}
          title="Schedules"
          // The header of the sidebar is narrow: words before the icon (B-028, B-037).
          icon={collapse ? undefined : <CalendarClock size={ICON_SIZE.xs} aria-hidden="true" />}
          suffix={suffix || undefined}
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
              {pauseToggle}

              <Tooltip content="New schedule" side="top">
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="New schedule"
                  data-testid="schedules-new-btn"
                  icon={<Plus size={ICON_SIZE.xs} />}
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
              icon={<Plus size={ICON_SIZE.xs} />}
              onClick={() => openScheduleEditor()}
            >
              New schedule
            </Button>
          ) : null}
          {pauseToggle}
        </div>
      )}
      {showTitle && concern !== "" ? (
        // On a line of its own: the header keeps its words (C-002, C-022).
        <button
          type="button"
          className="schedules__concern"
          onClick={() => collapse?.onChange(true)}
          data-testid="schedules-concern"
        >
          <StatusDot tone={failed > 0 ? "error" : "warning"} size="sm" ariaHidden />
          {concern}
        </button>
      ) : null}
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
                icon={<Plus size={ICON_SIZE.xs} />}
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
              repairable={labels.targets(s.targets).gone !== null}
              onRepair={() => openScheduleEditor({ scheduleId: s.id, startAtConnections: true })}
              justSaved={justSaved?.id === s.id}
              onToggle={(next) => handleToggle(s, next)}
              onEdit={() => openScheduleEditor({ scheduleId: s.id })}
              onShowHistory={() => showHistoryInSidebar(s.action.automationId)}
              onDelete={() => scheduleDelete.request({ id: s.id, name: s.name })}
            />
          ))}
        </div>
      )}
      <ScheduleSwitchOn schedule={confirming} onDone={() => setConfirming(null)} />
      <ConfirmDeleteDialog
        {...scheduleDelete.dialogProps}
        message={scheduleDelete.pending ? `Delete schedule “${scheduleDelete.pending.name}”?` : ""}
      />
    </section>
  );
}
