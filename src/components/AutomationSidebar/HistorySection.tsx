import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import { History, Trash2, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, ConfirmDialog, EmptyState, Select, Tooltip, toast } from "@/components/ui";
import { SidebarSectionHeader } from "@/components/Sidebar/SidebarSectionHeader";
import { errorMessage } from "@/utils/errorMessage";
import { t } from "@/i18n/catalog";
import { HistoryGapRow } from "./HistoryGapRow";
import { HistoryRunRow } from "./HistoryRunRow";
import { mergeHistory, scheduleGaps, schedulesOfRuns } from "./historyEntries";
import { automationFilterOptions, runsOfAutomation } from "./historyFormat";
import "./HistorySection.css";

/** The select value that shows every automation's runs. */
const ALL = "__all__";

/** Props of {@link HistorySection}. */
export interface HistorySectionProps {
  /** Show only this automation's runs; `null` shows every run. */
  automationId: string | null;
  /** Narrow the history to one automation, or `null` for every run again. */
  onFilterChange: (automationId: string | null) => void;
  /** Make the section collapsible (slice 6); absent = always open. */
  collapse?: { expanded: boolean; onChange: (expanded: boolean) => void };
}

/**
 * The one Automation history (#5818, slice 9): every recorded run, from a
 * macro playback, a workflow run or the migration, in one newest-first list
 * with one set of origin labels. Rows show the name, a status dot and when the
 * run ended; a row opens to show who started it, its outcome, its steps and
 * its terminals. The list can be narrowed to one automation, and "Clear…"
 * clears that automation's runs (or every run) after a confirmation. The times
 * a schedule did not run stand between the runs (#6024), so one list answers
 * what happened.
 * Metadata only: neither the typed input nor the terminal output is stored.
 */
export function HistorySection({ automationId, onFilterChange, collapse }: HistorySectionProps) {
  const contentId = useId();
  const open = collapse?.expanded ?? true;
  const automationRuns = useAppStore((s) => s.automationRuns);
  const automations = useAppStore((s) => s.automations);
  const loadAutomationRuns = useAppStore((s) => s.loadAutomationRuns);
  const clearAutomationRuns = useAppStore((s) => s.clearAutomationRuns);

  useEffect(() => {
    void loadAutomationRuns();
  }, [loadAutomationRuns]);

  const names = useMemo(() => new Map(automations.map((a) => [a.id, a.name])), [automations]);
  const schedules = useAppStore((s) => s.schedules);
  const clearScheduleHistory = useAppStore((s) => s.clearScheduleHistory);
  const allGaps = useMemo(() => scheduleGaps(schedules, names), [schedules, names]);
  const options = useMemo(
    () => automationFilterOptions([...automationRuns, ...allGaps], names),
    [automationRuns, allGaps, names]
  );
  const runs = useMemo(
    () => runsOfAutomation(automationRuns, automationId),
    [automationRuns, automationId]
  );
  const gaps = useMemo(
    () => (automationId ? allGaps.filter((g) => g.automationId === automationId) : allGaps),
    [allGaps, automationId]
  );
  const entries = useMemo(
    () => mergeHistory(runs, gaps, schedulesOfRuns(schedules)),
    [runs, gaps, schedules]
  );
  const filterName = automationId
    ? (names.get(automationId) ??
      options.find((o) => o.value === automationId)?.label ??
      "this automation")
    : null;

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);

  const handleToggle = useCallback((runId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  // The run that started another one (#6183, history-2): opened and focused.
  // Only a run the list shows is a link: a filtered-out caller stays a name.
  const shownRunIds = useMemo(
    () => new Set(entries.flatMap((e) => (e.kind === "run" ? [e.run.id] : []))),
    [entries]
  );
  const handleShowRun = useCallback((runId: string) => {
    flushSync(() => setExpanded((prev) => new Set(prev).add(runId)));
    const toggle = document.querySelector<HTMLElement>(
      `[data-testid="automation-run-toggle-${runId.replace(/["\\]/g, "\\$&")}"]`
    );
    toggle?.scrollIntoView?.({ block: "nearest" });
    toggle?.focus();
  }, []);

  const clear = useCallback(
    async (of: { runIds?: string[]; automationId: string | null }) => {
      setConfirmClear(false);
      try {
        await clearAutomationRuns(of.runIds);
        const ids = schedules
          .filter((s) => of.automationId === null || s.action.automationId === of.automationId)
          .filter((s) => (s.history ?? []).length > 0)
          .map((s) => s.id);
        if (ids.length > 0) await clearScheduleHistory(ids);
      } catch (err) {
        toast.error(`Failed to clear history: ${errorMessage(err)}`);
      }
    },
    [clearAutomationRuns, clearScheduleHistory, schedules]
  );

  const handleConfirm = useCallback(
    () => clear({ runIds: automationId ? runs.map((r) => r.id) : undefined, automationId }),
    [clear, automationId, runs]
  );
  const handleClearAll = useCallback(() => clear({ automationId: null }), [clear]);

  const selectOptions = useMemo(() => {
    const list = [{ value: ALL, label: t("automationHistory.filter.all") }, ...options];
    // A filter set from a row before that automation ran stays selectable.
    if (automationId && !options.some((o) => o.value === automationId)) {
      list.push({ value: automationId, label: filterName ?? automationId });
    }
    return list;
  }, [options, automationId, filterName]);

  const total = automationRuns.length + allGaps.length;
  const clearDisabled = entries.length === 0;

  return (
    <section
      className="automation-history"
      data-open={open ? "true" : "false"}
      data-testid="automation-history"
      aria-label="Automation history"
    >
      <SidebarSectionHeader
        title="History"
        data-testid="automation-history-header"
        icon={<History size={12} aria-hidden="true" />}
        collapse={
          collapse
            ? {
                expanded: open,
                onToggle: () => collapse.onChange(!open),
                controls: contentId,
                testId: "automation-history-toggle",
              }
            : undefined
        }
        actions={
          // Clear belongs to the runs it clears: nothing destructive on a closed section.
          !open ? null : (
            <Tooltip
              content={
                automationId
                  ? `Clear the history of “${filterName}”…`
                  : "Clear the history of every automation…"
              }
              side="top"
            >
              <Button
                variant="ghost"
                size="sm"
                className="automation-history__clear"
                aria-label="Clear history"
                data-testid="automation-history-clear"
                icon={<Trash2 size={12} />}
                disabled={clearDisabled}
                onClick={() => setConfirmClear(true)}
              >
                Clear…
              </Button>
            </Tooltip>
          )
        }
      />
      {open && (total > 0 || automationId) ? (
        <div className="automation-history__filter-bar">
          <Select
            value={automationId ?? ALL}
            onChange={(value) => onFilterChange(value === ALL ? null : value)}
            options={selectOptions}
            aria-label="Filter by automation"
            data-testid="automation-history-filter"
          />
          {automationId ? (
            <Tooltip content="Show every automation" side="top">
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label={`Clear filter: ${filterName}`}
                data-testid="automation-history-show-all"
                icon={<X size={12} />}
                onClick={() => onFilterChange(null)}
              />
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmClear}
        title={automationId ? `Clear the history of “${filterName}”?` : "Clear automation history?"}
        variant="danger"
        message={
          automationId
            ? `This removes the recorded runs of “${filterName}”. It cannot be undone.`
            : "This removes the recorded runs of every automation. It cannot be undone."
        }
        confirmLabel={automationId ? "Clear this history" : "Clear history"}
        confirmVariant="danger"
        // Both clear for good, so both look so, and each names its scope (live
        // review history-1): the wider one must not look like the safe choice.
        alternateAction={
          automationId && total > entries.length
            ? { label: "Clear all history", variant: "danger", onClick: handleClearAll }
            : undefined
        }
        testIdBase="automation-history-clear-confirm"
        onConfirm={handleConfirm}
        onCancel={() => setConfirmClear(false)}
      />
      {!open ? null : entries.length === 0 ? (
        <div id={contentId}>
          <EmptyState
            title={automationId ? t("automationHistory.empty.filtered") : t("runHistory.empty")}
            data-testid="automation-history-empty"
          />
        </div>
      ) : (
        <div
          id={contentId}
          className="automation-history__list"
          role="list"
          data-testid="automation-history-list"
        >
          {entries.map((entry) =>
            entry.kind === "run" ? (
              <HistoryRunRow
                key={entry.run.id}
                run={entry.run}
                schedule={entry.schedule}
                expanded={expanded.has(entry.run.id)}
                onToggle={handleToggle}
                oneAutomation={automationId !== null}
                onShowRun={
                  entry.run.startedByRunId && shownRunIds.has(entry.run.startedByRunId)
                    ? handleShowRun
                    : undefined
                }
              />
            ) : (
              <HistoryGapRow
                key={entry.gap.id}
                gap={entry.gap}
                expanded={expanded.has(entry.gap.id)}
                onToggle={handleToggle}
              />
            )
          )}
        </div>
      )}
    </section>
  );
}
