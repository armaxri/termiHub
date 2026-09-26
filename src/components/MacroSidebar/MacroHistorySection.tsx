import { useCallback, useEffect, useMemo } from "react";
import { History, Trash2, X } from "lucide-react";
import { useAppStore } from "@/store/appStore";
import { Button, StatusDot, Tooltip, toast } from "@/components/ui";
import type { StatusTone } from "@/components/ui";
import { SidebarListItem } from "@/components/SidebarListItem";
import type { MacroRun, MacroRunOrigin, MacroRunStatus } from "@/types/macro";
import { formatAbsoluteTime, formatElapsed, formatRelativeTime } from "@/utils/formatters";
import { errorMessage } from "@/utils/errorMessage";

/** Map a playback's terminal status to a {@link StatusDot} tone. */
function statusTone(status: MacroRunStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "error":
      return "error";
    case "cancelled":
      return "warning";
  }
}

/** Human label for a playback's terminal status. */
function statusLabel(status: MacroRunStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "error":
      return "Target disconnected";
    case "cancelled":
      return "Cancelled";
  }
}

/** Human label for what launched a playback. */
function originLabel(origin: MacroRunOrigin): string {
  switch (origin) {
    case "manual":
      return "manual";
    case "palette":
      return "palette";
    case "workflow-step":
      return "workflow step";
    case "scheduled":
      return "scheduled";
  }
}

/** The playback's duration as a compact string (e.g. `2s`); empty if unknown. */
function runDuration(run: MacroRun): string {
  const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  return formatElapsed(Math.round(ms / 1000));
}

/** Where a playback went: the single target's label, or "N terminals". */
function targetsText(run: MacroRun): string {
  const labels = run.targetLabels ?? [];
  if (run.targetCount === 1 && labels.length === 1) return labels[0];
  return `${run.targetCount} terminal${run.targetCount === 1 ? "" : "s"}`;
}

/** Props of {@link MacroHistorySection}. */
export interface MacroHistorySectionProps {
  /** Show only this macro's playbacks; `null` shows every macro's. */
  macroId: string | null;
  /** Drop the per-macro filter and show every playback again. */
  onShowAll: () => void;
}

/**
 * The persisted macro run-history panel (#3543), mirroring the workflow run
 * history: recent playbacks — outcome, when and how long, into which terminals,
 * and what launched each — beneath the macro library, optionally narrowed to
 * one macro, with a single "Clear history" action. Metadata only: the macro's
 * recorded input is never stored.
 */
export function MacroHistorySection({ macroId, onShowAll }: MacroHistorySectionProps) {
  const macroRuns = useAppStore((s) => s.macroRuns);
  const loadMacroRuns = useAppStore((s) => s.loadMacroRuns);
  const clearMacroRunHistory = useAppStore((s) => s.clearMacroRunHistory);

  useEffect(() => {
    void loadMacroRuns();
  }, [loadMacroRuns]);

  const runs = useMemo(
    () => (macroId ? macroRuns.filter((r) => r.macroId === macroId) : macroRuns),
    [macroRuns, macroId]
  );

  const handleClear = useCallback(async () => {
    try {
      await clearMacroRunHistory();
      toast.success("Cleared macro run history");
    } catch (err) {
      toast.error(`Failed to clear history: ${errorMessage(err)}`);
    }
  }, [clearMacroRunHistory]);

  const filterName = macroId ? (runs[0]?.macroName ?? null) : null;

  return (
    <section className="macro-history" data-testid="macro-history" aria-label="Macro run history">
      <header className="macro-history__header">
        <span className="macro-history__title">
          <History size={12} aria-hidden="true" /> History
          {macroId ? (
            <span className="macro-history__filter" data-testid="macro-history-filter">
              · {filterName ?? "this macro"}
            </span>
          ) : null}
        </span>
        <span className="macro-history__actions">
          {macroId ? (
            <Tooltip content="Show all macros" side="top">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label="Show all macros"
                data-testid="macro-history-show-all"
                icon={<X size={12} />}
                onClick={onShowAll}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={macroId ? "Clear history (all macros)" : "Clear history"} side="top">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label="Clear history"
              data-testid="macro-history-clear"
              icon={<Trash2 size={12} />}
              disabled={macroRuns.length === 0}
              onClick={() => void handleClear()}
            />
          </Tooltip>
        </span>
      </header>
      {runs.length === 0 ? (
        <div className="macro-history__empty" data-testid="macro-history-empty">
          {macroId ? "This macro has not been played yet." : "No playbacks recorded yet."}
        </div>
      ) : (
        <div className="macro-history__list" data-testid="macro-history-list">
          {runs.map((run) => {
            const duration = runDuration(run);
            return (
              <SidebarListItem
                key={run.id}
                testId={`macro-run-${run.id}`}
                name={run.macroName}
                status={
                  <StatusDot
                    tone={statusTone(run.status)}
                    label={statusLabel(run.status)}
                    title={statusLabel(run.status)}
                  />
                }
                badge={`${run.stepsPlayed}/${run.totalSteps}`}
                actions={null}
                details={
                  <span className="macro-history__meta">
                    <time dateTime={run.endedAt} title={formatAbsoluteTime(run.endedAt)}>
                      {formatRelativeTime(run.endedAt)}
                    </time>
                    {duration ? <span> · {duration}</span> : null}
                    <span> · {originLabel(run.origin)}</span>
                    <span
                      title={run.targetLabels?.join("\n")}
                      data-testid={`macro-run-targets-${run.id}`}
                    >
                      {" "}
                      · {targetsText(run)}
                    </span>
                    {run.error ? (
                      <span
                        className="macro-history__error"
                        data-testid={`macro-run-error-${run.id}`}
                      >
                        {run.error}
                      </span>
                    ) : null}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
