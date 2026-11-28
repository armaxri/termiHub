import { useRef } from "react";
import { ChevronRight, Pencil, Play } from "lucide-react";
import { Button, StatusDot, TruncatedText } from "@/components/ui";
import { attemptLabel, attemptTone } from "@/components/Schedules/scheduleStatus";
import { t } from "@/i18n/catalog";
import { formatAbsoluteTime, formatDayTime } from "@/utils/formatters";
import { openRunPicker } from "@/services/contextCommands";
import { useAppStore } from "@/store/appStore";
import { nextStepAfterGap } from "./historyFormat";
import { useRevealWhenOpened } from "./useRevealWhenOpened";
import type { ScheduleGap } from "./historyEntries";

import { ICON_SIZE } from "@/components/ui/iconSize";
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
  const next = nextStepAfterGap(summary);
  const openScheduleEditor = useAppStore((s) => s.openScheduleEditor);
  const row = useRef<HTMLDivElement>(null);
  useRevealWhenOpened(row, expanded);
  return (
    <div
      ref={row}
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
          size={ICON_SIZE.xs}
          aria-hidden="true"
          className={
            expanded
              ? "automation-history__chevron automation-history__chevron--open"
              : "automation-history__chevron"
          }
        />
        <span className="automation-history__main">
          <TruncatedText className="automation-history__name">{gap.automationName}</TruncatedText>
          <span className="automation-history__line">
            <StatusDot tone={attemptTone(summary.kind)} size="sm" ariaHidden />
            <span className="automation-history__outcome">{label}</span>
            <time dateTime={summary.when} title={formatAbsoluteTime(summary.when)}>
              {formatDayTime(summary.when)}
            </time>
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="automation-history__details" id={detailsId} data-testid={detailsId}>
          <dl className="automation-history__facts">
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
            {next !== null ? (
              <>
                <dt>What to do</dt>
                <dd data-testid={`automation-gap-next-${gap.id}`}>{next}</dd>
              </>
            ) : null}
          </dl>
          <div className="automation-history__actions">
            <Button
              variant="secondary"
              size="sm"
              icon={<Pencil size={ICON_SIZE.xs} />}
              onClick={() => openScheduleEditor({ scheduleId: gap.scheduleId })}
              data-testid={`automation-gap-edit-${gap.id}`}
            >
              Edit schedule
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Play size={ICON_SIZE.xs} />}
              onClick={() => openRunPicker(gap.automationId)}
              data-testid={`automation-gap-run-${gap.id}`}
            >
              Run now…
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
