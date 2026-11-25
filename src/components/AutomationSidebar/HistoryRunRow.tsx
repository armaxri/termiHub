import { useRef } from "react";
import { ChevronRight } from "lucide-react";
import { StatusDot, TruncatedText } from "@/components/ui";
import type { RunSchedule } from "./historyEntries";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { formatAbsoluteTime, formatDayTime } from "@/utils/formatters";
import { useRevealWhenOpened } from "./useRevealWhenOpened";
import { HistoryRunDetails } from "./HistoryRunDetails";
import {
  automationRunStatusLabel,
  automationRunTargets,
  automationRunTone,
  toleratedText,
} from "./historyFormat";

/** Props of {@link HistoryRunRow}. */
export interface HistoryRunRowProps {
  /** The run record to show. */
  run: AutomationRun;
  /** The schedule that started it, when one did. */
  schedule?: RunSchedule;
  /** Whether the run's details are shown. */
  expanded: boolean;
  /** Show or hide the run's details. */
  onToggle: (runId: string) => void;
}

/**
 * One row of the Automation history (#5818, slice 9): the automation's name, and
 * under it in words how the run ended, when and where (#6026), so two runs of one
 * automation can be told apart. Activating the row discloses the rest.
 */
export function HistoryRunRow({ run, schedule, expanded, onToggle }: HistoryRunRowProps) {
  const detailsId = `automation-run-details-${run.id}`;
  const targets = automationRunTargets(run);
  const row = useRef<HTMLDivElement>(null);
  useRevealWhenOpened(row, expanded);

  return (
    <div
      ref={row}
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
        <span className="automation-history__main">
          <TruncatedText
            className="automation-history__name"
            data-testid={`automation-run-name-${run.id}`}
          >
            {run.automationName}
          </TruncatedText>
          {/* In words: a dot's colour alone says nothing to many (A-038). */}
          <span className="automation-history__line">
            <StatusDot tone={automationRunTone(run.status)} size="sm" ariaHidden />
            <span
              className="automation-history__outcome"
              data-testid={`automation-run-outcome-${run.id}`}
            >
              {automationRunStatusLabel(run.status)}
              {run.continuedFailures ? ` · ${toleratedText(run.continuedFailures)}` : ""}
            </span>
            <time
              dateTime={run.endedAt}
              title={formatAbsoluteTime(run.endedAt)}
              data-testid={`automation-run-time-${run.id}`}
            >
              {formatDayTime(run.endedAt)}
            </time>
            {targets.length > 0 ? (
              <TruncatedText className="automation-history__target">
                {targets.length === 1 ? targets[0] : `${targets.length} terminals`}
              </TruncatedText>
            ) : null}
          </span>
        </span>
      </button>
      {expanded ? <HistoryRunDetails run={run} schedule={schedule} id={detailsId} /> : null}
    </div>
  );
}
