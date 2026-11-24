import { ChevronRight } from "lucide-react";
import { StatusDot, TruncatedText } from "@/components/ui";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { formatAbsoluteTime, formatRelativeTime } from "@/utils/formatters";
import {
  automationRunDuration,
  automationRunOriginDetail,
  automationRunOriginLabel,
  automationRunProgress,
  automationRunStatusLabel,
  automationRunTargets,
  automationRunTone,
} from "./historyFormat";

/** Props of {@link HistoryRunRow}. */
export interface HistoryRunRowProps {
  /** The run record to show. */
  run: AutomationRun;
  /** Whether the run's details are shown. */
  expanded: boolean;
  /** Show or hide the run's details. */
  onToggle: (runId: string) => void;
}

/**
 * One row of the Automation history (#5818, slice 9). At rest the row shows
 * only what tells runs apart at a glance: the automation's name, a status dot
 * and when it ended (names, not settings: docs/copy-style.md). Activating the
 * row discloses the run's details: who started it, its outcome, how far it
 * got, the terminals it ran on and any error.
 */
export function HistoryRunRow({ run, expanded, onToggle }: HistoryRunRowProps) {
  const detailsId = `automation-run-details-${run.id}`;
  const status = automationRunStatusLabel(run.status);
  const origin = automationRunOriginLabel(run.origin);
  const via = automationRunOriginDetail(run.origin);
  const duration = automationRunDuration(run);
  const targets = automationRunTargets(run);
  const failedStep =
    run.status === "failed" && run.failedStepIndex !== undefined ? run.failedStepIndex + 1 : null;

  return (
    <div
      className="automation-history__run"
      role="listitem"
      data-testid={`automation-run-${run.id}`}
      data-origin={run.origin}
      data-status={run.status}
    >
      <button
        type="button"
        className="automation-history__row"
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        data-testid={`automation-run-toggle-${run.id}`}
        onClick={() => onToggle(run.id)}
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={
            expanded
              ? "automation-history__chevron automation-history__chevron--open"
              : "automation-history__chevron"
          }
        />
        <StatusDot tone={automationRunTone(run.status)} label={status} title={status} />
        <TruncatedText
          className="automation-history__name"
          data-testid={`automation-run-name-${run.id}`}
        >
          {run.automationName}
        </TruncatedText>
        <time
          className="automation-history__time"
          dateTime={run.endedAt}
          title={formatAbsoluteTime(run.endedAt)}
          data-testid={`automation-run-time-${run.id}`}
        >
          {formatRelativeTime(run.endedAt)}
        </time>
      </button>
      {expanded ? (
        <dl className="automation-history__details" id={detailsId} data-testid={detailsId}>
          <dt>Started by</dt>
          <dd data-testid={`automation-run-origin-${run.id}`}>
            {origin}
            {via ? <span className="automation-history__via"> · {via}</span> : null}
          </dd>
          <dt>Outcome</dt>
          <dd data-testid={`automation-run-status-${run.id}`}>
            {failedStep !== null ? `${status} at step ${failedStep}` : status}
            {run.continuedFailures
              ? ` · ${run.continuedFailures} tolerated failure${run.continuedFailures === 1 ? "" : "s"}`
              : ""}
          </dd>
          <dt>Steps</dt>
          <dd data-testid={`automation-run-steps-${run.id}`}>{automationRunProgress(run)}</dd>
          <dt>When</dt>
          <dd>
            {formatAbsoluteTime(run.startedAt)}
            {duration ? ` · ${duration}` : ""}
          </dd>
          {targets.length > 0 ? (
            <>
              <dt>{targets.length === 1 ? "Terminal" : "Terminals"}</dt>
              <dd data-testid={`automation-run-target-${run.id}`}>{targets.join(", ")}</dd>
            </>
          ) : null}
          {run.error ? (
            <>
              <dt>Error</dt>
              <dd
                className="automation-history__error"
                data-testid={`automation-run-error-${run.id}`}
              >
                {run.error}
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
