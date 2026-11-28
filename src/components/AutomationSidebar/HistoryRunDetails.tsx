import { Pencil, Play, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui";
import { useAutomationEditor } from "@/components/AutomationEditor";
import { collectLiveTabs, getActiveTab, useAppStore } from "@/store/appStore";
import { openRunPicker } from "@/services/contextCommands";
import { t } from "@/i18n/catalog";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import { formatDayTime } from "@/utils/formatters";
import { showTerminal } from "@/utils/showTerminal";
import type { RunSchedule } from "./historyEntries";
import {
  automationRunDuration,
  automationRunOriginDetail,
  automationRunOutcome,
  automationRunProgress,
  automationRunStarter,
  automationRunTargets,
  nextStepAfter,
} from "./historyFormat";

import { ICON_SIZE } from "@/components/ui/iconSize";
/** Props of {@link HistoryRunDetails}. */
export interface HistoryRunDetailsProps {
  /** The run record to show. */
  run: AutomationRun;
  /** The schedule that started it, when one did. */
  schedule?: RunSchedule;
  id: string;
}

/** A reason as a sentence: an error starts as it is, mostly without a capital. */
function sentence(reason: string): string {
  return reason[0].toUpperCase() + reason.slice(1);
}

/**
 * What a run says when its row is open (#5818, #6026): how it ended and at which
 * step of what kind, why, what to do next, who started it, how long it took, and
 * the ways on: its automation, its terminal, another run (which asks where).
 */
export function HistoryRunDetails({ run, schedule, id }: HistoryRunDetailsProps) {
  const automation = useAppStore((s) => s.automations.find((a) => a.id === run.automationId));
  const openEditor = useAutomationEditor((s) => s.open);
  // Its terminal, while it is open here and not the one in front already.
  const terminalOpen = useAppStore(
    (s) =>
      run.tabId !== undefined &&
      getActiveTab(s)?.id !== run.tabId &&
      collectLiveTabs(s).some((x) => x.id === run.tabId)
  );
  const via = automationRunOriginDetail(run.origin);
  const duration = automationRunDuration(run);
  const targets = automationRunTargets(run);
  const next = nextStepAfter(run);

  return (
    <div className="automation-history__details" id={id} data-testid={id}>
      <dl className="automation-history__facts">
        <dt>Outcome</dt>
        <dd data-testid={`automation-run-status-${run.id}`}>
          {automationRunOutcome(run, automation)}
        </dd>
        {run.error ? (
          <>
            <dt>Why</dt>
            <dd
              className="automation-history__error"
              data-testid={`automation-run-error-${run.id}`}
            >
              {sentence(run.error)}
            </dd>
          </>
        ) : null}
        {next !== null ? (
          <>
            <dt>What to do</dt>
            <dd data-testid={`automation-run-next-${run.id}`}>{next}</dd>
          </>
        ) : null}
        <dt>Started by</dt>
        <dd data-testid={`automation-run-origin-${run.id}`}>
          {automationRunStarter(run.origin, schedule?.name)}
          {via ? <span className="automation-history__via"> · {via}</span> : null}
          {schedule?.leftOut ? (
            <span data-testid={`automation-run-schedule-${run.id}`}> · {schedule.leftOut}</span>
          ) : null}
        </dd>
        {run.status !== "failed" ? (
          <>
            <dt>Steps</dt>
            <dd data-testid={`automation-run-steps-${run.id}`}>
              {automationRunProgress(run, automation)}
            </dd>
          </>
        ) : null}
        <dt>When</dt>
        <dd>
          {formatDayTime(run.startedAt)}
          {duration ? ` · ${duration}` : ""}
        </dd>
        {targets.length > 0 ? (
          <>
            <dt>{targets.length === 1 ? "Terminal" : "Terminals"}</dt>
            <dd data-testid={`automation-run-target-${run.id}`}>{targets.join(", ")}</dd>
          </>
        ) : null}
      </dl>
      <div className="automation-history__actions">
        {automation ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Pencil size={ICON_SIZE.xs} />}
              onClick={() => openEditor(automation, false)}
              data-testid={`automation-run-edit-${run.id}`}
            >
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Play size={ICON_SIZE.xs} />}
              onClick={() => openRunPicker(automation.id)}
              data-testid={`automation-run-again-${run.id}`}
            >
              Run again…
            </Button>
          </>
        ) : (
          <span className="automation-history__via">{t("automationHistory.deleted")}</span>
        )}
        {terminalOpen && run.tabId !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<SquareTerminal size={ICON_SIZE.xs} />}
            onClick={() => showTerminal(run.tabId ?? "")}
            data-testid={`automation-run-show-${run.id}`}
          >
            Show terminal
          </Button>
        ) : null}
      </div>
    </div>
  );
}
