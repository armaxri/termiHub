import { ChevronRight } from "lucide-react";
import { StatusDot, TruncatedText } from "@/components/ui";
import { attemptLabel, attemptTone } from "@/components/Schedules/scheduleStatus";
import { t } from "@/i18n/catalog";
import { formatAbsoluteTime, formatDayTime } from "@/utils/formatters";
import type { ScheduleGap } from "./historyEntries";

/** Props of {@link HistoryGapRow}. */
export interface HistoryGapRowProps {
  gap: ScheduleGap;
  expanded: boolean;
  onToggle: (id: string) => void;
}

/**
 * A scheduled time at which nothing ran (#6024), in the History between the runs:
 * the row says so in a word, and opens to which schedule it was and why.
 */
export function HistoryGapRow({ gap, expanded, onToggle }: HistoryGapRowProps) {
  const { summary } = gap;
  const detailsId = `automation-gap-details-${gap.id}`;
  const label = attemptLabel(summary.kind);
  return (
    <div
      className="automation-history__run"
      role="listitem"
      data-testid={`automation-gap-${gap.id}`}
      data-kind={summary.kind}
    >
      <button
        type="button"
        className="automation-history__row"
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        data-testid={`automation-gap-toggle-${gap.id}`}
        onClick={() => onToggle(gap.id)}
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
        <StatusDot tone={attemptTone(summary.kind)} ariaHidden />
        <TruncatedText className="automation-history__name">{gap.automationName}</TruncatedText>
        <span className="automation-history__outcome">{label}</span>
        <time
          className="automation-history__time"
          dateTime={summary.when}
          title={formatAbsoluteTime(summary.when)}
        >
          {formatDayTime(summary.when)}
        </time>
      </button>
      {expanded ? (
        <dl className="automation-history__details" id={detailsId} data-testid={detailsId}>
          <dt>{t("automationHistory.schedule")}</dt>
          <dd>{gap.scheduleName}</dd>
          <dt>Outcome</dt>
          <dd>{label}</dd>
          <dt>{summary.kind === "missed" ? t("automationHistory.due") : "When"}</dt>
          <dd>{formatDayTime(summary.when)}</dd>
          <dt>{t("automationHistory.reason")}</dt>
          <dd data-testid={`automation-gap-reason-${gap.id}`}>
            {summary.reason ?? t("schedule.last.unknownReason")}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}
