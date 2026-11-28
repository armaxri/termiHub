import { useRef } from "react";
import { CalendarClock, ChevronRight, CornerDownRight, Zap } from "lucide-react";
import { StatusDot, TruncatedText } from "@/components/ui";
import type { RunSchedule } from "./historyEntries";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { formatAbsoluteTime, formatDayTime } from "@/utils/formatters";
import { useRevealWhenOpened } from "./useRevealWhenOpened";
import { HistoryRunDetails } from "./HistoryRunDetails";
import { automationRunStatusLabel, automationRunTargets, automationRunTone } from "./historyFormat";

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
  /** Open another run of the list, by id (the one that started this run). */
  onShowRun?: (runId: string) => void;
  /**
   * The list shows one automation's runs: its name is in the filter, so the
   * row is titled by its terminal instead (#6183, automations-3).
   */
  oneAutomation?: boolean;
}

/** The mark of who started a run, beside its dot; `null` for you (#6183, macro-3). */
function originMark(origin: AutomationRun["origin"]): {
  kind: "schedule" | "trigger" | "automation";
  label: string;
  Icon: typeof Zap;
} | null {
  switch (origin) {
    case "scheduled":
      return { kind: "schedule", label: "Started by a schedule", Icon: CalendarClock };
    case "on-connect":
    case "on-disconnect":
    case "on-output-match":
      return { kind: "trigger", label: "Started by a trigger", Icon: Zap };
    case "run-by-automation":
      return { kind: "automation", label: "Started by another automation", Icon: CornerDownRight };
    default:
      return null;
  }
}

/**
 * One row of the Automation history (#5818, slice 9), on one line (#6183): its
 * outcome dot, who started it, the automation's name, its terminal and when it
 * ended, so two runs of one automation can be told apart and more of them fit.
 * A run that did not complete says so in words beside its dot (A-038); a
 * completed one says it only to assistive tech. Activating the row discloses
 * the rest.
 */
export function HistoryRunRow({
  run,
  schedule,
  expanded,
  onToggle,
  onShowRun,
  oneAutomation = false,
}: HistoryRunRowProps) {
  const detailsId = `automation-run-details-${run.id}`;
  const targets = automationRunTargets(run);
  const row = useRef<HTMLDivElement>(null);
  useRevealWhenOpened(row, expanded);
  const where = targets.length > 1 ? `${targets.length} terminals` : (targets[0] ?? null);
  const title = oneAutomation && where !== null ? where : run.automationName;
  const mark = originMark(run.origin);
  const outcome = `${automationRunStatusLabel(run.status)}${
    // Short on the row, which shares a line; the details say the rest.
    run.continuedFailures ? ` · ${run.continuedFailures} failed` : ""
  }`;

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
        <StatusDot tone={automationRunTone(run.status)} size="sm" ariaHidden />
        {mark ? (
          <mark.Icon
            size={12}
            className="automation-history__origin"
            role="img"
            aria-label={mark.label}
            data-kind={mark.kind}
            data-testid={`automation-run-origin-icon-${run.id}`}
          />
        ) : null}
        <span className="automation-history__main">
          <TruncatedText
            className="automation-history__name"
            data-testid={`automation-run-name-${run.id}`}
          >
            {title}
          </TruncatedText>
          {/* In words when it did not complete: a dot's colour alone says nothing
              to many (A-038). A completed run says it to assistive tech only. */}
          {run.status === "completed" && !run.continuedFailures ? (
            <span className="ui-visually-hidden">, {outcome}</span>
          ) : (
            <span
              className="automation-history__outcome"
              data-testid={`automation-run-outcome-${run.id}`}
            >
              {outcome}
            </span>
          )}
          {!oneAutomation && where !== null ? (
            <TruncatedText className="automation-history__target">{where}</TruncatedText>
          ) : null}
        </span>
        <time
          className="automation-history__time"
          dateTime={run.endedAt}
          title={formatAbsoluteTime(run.endedAt)}
          data-testid={`automation-run-time-${run.id}`}
        >
          {formatDayTime(run.endedAt)}
        </time>
      </button>
      {expanded ? (
        <HistoryRunDetails run={run} schedule={schedule} id={detailsId} onShowRun={onShowRun} />
      ) : null}
    </div>
  );
}
