import { useCallback, useEffect, useMemo, useState } from "react";
import { History, Trash2, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, ConfirmDialog, EmptyState, Select, Tooltip, toast } from "@/components/ui";
import { SidebarSectionHeader } from "@/components/Sidebar/SidebarSectionHeader";
import { errorMessage } from "@/utils/errorMessage";
import { t } from "@/i18n/catalog";
import { HistoryRunRow } from "./HistoryRunRow";
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
}

/**
 * The one Automation history (#5818, slice 9): every recorded run, from a
 * macro playback, a workflow run or the migration, in one newest-first list
 * with one set of origin labels. Rows show the name, a status dot and when the
 * run ended; a row opens to show who started it, its outcome, its steps and
 * its terminals. The list can be narrowed to one automation, and "Clear…"
 * clears that automation's runs (or every run) after a confirmation.
 * Metadata only: neither the typed input nor the terminal output is stored.
 */
export function HistorySection({ automationId, onFilterChange }: HistorySectionProps) {
  const automationRuns = useAppStore((s) => s.automationRuns);
  const automations = useAppStore((s) => s.automations);
  const loadAutomationRuns = useAppStore((s) => s.loadAutomationRuns);
  const clearAutomationRuns = useAppStore((s) => s.clearAutomationRuns);

  useEffect(() => {
    void loadAutomationRuns();
  }, [loadAutomationRuns]);

  const names = useMemo(() => new Map(automations.map((a) => [a.id, a.name])), [automations]);
  const options = useMemo(
    () => automationFilterOptions(automationRuns, names),
    [automationRuns, names]
  );
  const runs = useMemo(
    () => runsOfAutomation(automationRuns, automationId),
    [automationRuns, automationId]
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

  const clear = useCallback(
    async (runIds?: string[]) => {
      setConfirmClear(false);
      try {
        await clearAutomationRuns(runIds);
      } catch (err) {
        toast.error(`Failed to clear history: ${errorMessage(err)}`);
      }
    },
    [clearAutomationRuns]
  );

  const handleConfirm = useCallback(
    () => clear(automationId ? runs.map((r) => r.id) : undefined),
    [clear, automationId, runs]
  );
  const handleClearAll = useCallback(() => clear(), [clear]);

  const selectOptions = useMemo(() => {
    const list = [{ value: ALL, label: t("automationHistory.filter.all") }, ...options];
    // A filter set from a row before that automation ran stays selectable.
    if (automationId && !options.some((o) => o.value === automationId)) {
      list.push({ value: automationId, label: filterName ?? automationId });
    }
    return list;
  }, [options, automationId, filterName]);

  const clearDisabled = automationId ? runs.length === 0 : automationRuns.length === 0;

  return (
    <section
      className="automation-history"
      data-testid="automation-history"
      aria-label="Automation history"
    >
      <SidebarSectionHeader
        title="History"
        data-testid="automation-history-header"
        icon={<History size={12} aria-hidden="true" />}
        actions={
          <Tooltip
            content={
              automationId
                ? `Clear the history of "${filterName}"…`
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
        }
      />
      {automationRuns.length > 0 || automationId ? (
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
        title={automationId ? `Clear the history of "${filterName}"?` : "Clear automation history?"}
        variant="danger"
        message={
          automationId
            ? `This removes the recorded runs of "${filterName}". It cannot be undone.`
            : "This removes the recorded runs of every automation. It cannot be undone."
        }
        confirmLabel="Clear history"
        confirmVariant="danger"
        alternateAction={
          automationId && automationRuns.length > runs.length
            ? { label: "Clear all history", variant: "secondary", onClick: handleClearAll }
            : undefined
        }
        testIdBase="automation-history-clear-confirm"
        onConfirm={handleConfirm}
        onCancel={() => setConfirmClear(false)}
      />
      {runs.length === 0 ? (
        <EmptyState
          title={automationId ? t("automationHistory.empty.filtered") : t("runHistory.empty")}
          data-testid="automation-history-empty"
        />
      ) : (
        <div className="automation-history__list" role="list" data-testid="automation-history-list">
          {runs.map((run) => (
            <HistoryRunRow
              key={run.id}
              run={run}
              expanded={expanded.has(run.id)}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}
