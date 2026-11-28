import { Ban, CalendarClock, Hand, Square, TriangleAlert, Zap, ZapOff } from "lucide-react";
import type React from "react";
import { Button, Toggle } from "@/components/ui";
import { t, tf } from "@/i18n/catalog";
import { joinWords } from "@/utils/joinWords";
import type { AutomationRunTarget } from "./AutomationRow";
import type { TriggerState } from "./automationRowInfo";

/** Props of {@link RowLines}. */
export interface RowLinesProps {
  id: string;
  name: string;
  /** The terminals it runs on right now. */
  targets: AutomationRunTarget[];
  /** Why it cannot run. */
  blocked: string | null;
  /** What an import left out of it, until it was saved once. */
  importedInPart: string[];
  /** The step that runs an automation that is not there (files-2), or `null`. */
  missingCalleeStep?: number | null;
  onEdit: () => void;
  /** What starts it, or does not while its triggers are off. */
  triggers: TriggerState | null;
  /** When a schedule runs it next. */
  nextRun: string | null;
  onSetTriggers: (on: boolean) => void;
}

/** Keep a control's clicks and Enter/Space off the row, which acts on them. */
export const keepOffRow = {
  onClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  },
};

/** The lines under an automation's name (#6026): its state and what starts it, in words. */
export function RowLines({
  id,
  name,
  targets,
  blocked,
  importedInPart,
  missingCalleeStep = null,
  onEdit,
  triggers,
  nextRun,
  onSetTriggers,
}: RowLinesProps) {
  const several = targets.length > 1;
  return (
    <>
      {targets.length > 0 && (
        <ul
          className="automation-item__targets"
          aria-label="Running terminals"
          data-testid={`automation-targets-${id}`}
        >
          {targets.map((target) => (
            <li
              key={target.key}
              className={`automation-item__line automation-item__line--target${
                target.waiting ? " automation-item__line--waiting" : ""
              }`}
              data-testid={`automation-target-${target.key}`}
              {...keepOffRow}
            >
              {target.waiting && <Hand size={10} aria-hidden="true" />}
              <button
                type="button"
                className="automation-item__where"
                aria-label={`${target.progress}. ${tf("automation.running.show", { tab: target.label })}`}
                onClick={target.onShow}
                data-testid={`automation-target-show-${target.key}`}
              >
                {target.progress}
              </button>
              {several && (
                <Button
                  variant="ghost"
                  size="xs"
                  iconOnly
                  aria-label={tf("automation.stop.target", { target: target.label })}
                  data-testid={`automation-target-stop-${target.key}`}
                  icon={<Square size={10} fill="currentColor" />}
                  onClick={target.onStop}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {blocked !== null && (
        <div
          className="automation-item__line automation-item__line--blocked"
          data-testid={`automation-blocked-reason-${id}`}
        >
          <Ban size={10} aria-hidden="true" />
          <span className="automation-item__line-text">{blocked}</span>
        </div>
      )}
      {importedInPart.length > 0 && (
        <div
          className="automation-item__line automation-item__line--warning"
          data-testid={`automation-imported-part-${id}`}
          {...keepOffRow}
        >
          <TriangleAlert size={10} aria-hidden="true" />
          <span className="automation-item__line-text">
            {tf("automation.importedInPart", { parts: joinWords(importedInPart) })}{" "}
            <button
              type="button"
              className="automation-item__link"
              onClick={onEdit}
              data-testid={`automation-imported-check-${id}`}
            >
              {t("automation.importedCheck")}
            </button>
          </span>
        </div>
      )}
      {missingCalleeStep !== null && (
        <div
          className="automation-item__line automation-item__line--warning"
          data-testid={`automation-missing-callee-${id}`}
          {...keepOffRow}
        >
          <TriangleAlert size={10} aria-hidden="true" />
          <span className="automation-item__line-text">
            {tf("automation.missingCallee", { step: String(missingCalleeStep) })}{" "}
            <button
              type="button"
              className="automation-item__link"
              onClick={onEdit}
              data-testid={`automation-missing-callee-edit-${id}`}
            >
              {t("automation.missingCalleeChoose")}
            </button>
          </span>
        </div>
      )}
      {triggers !== null && (
        <div
          className={
            triggers.effective
              ? "automation-item__line automation-item__line--on"
              : triggers.on
                ? "automation-item__line automation-item__line--warning"
                : "automation-item__line"
          }
        >
          {triggers.effective ? (
            <Zap size={10} aria-hidden="true" />
          ) : (
            <ZapOff size={10} aria-hidden="true" />
          )}
          <span
            className="automation-item__line-text"
            data-testid={`automation-armed-${id}`}
            data-armed={triggers.on ? "true" : "false"}
          >
            {triggers.text}
          </span>
          <span className="automation-item__arm-toggle" {...keepOffRow}>
            <Toggle
              checked={triggers.on}
              onCheckedChange={onSetTriggers}
              aria-label={tf(
                triggers.on ? "automation.triggers.toggleOff" : "automation.triggers.toggleOn",
                { name }
              )}
              data-testid={`automation-arm-toggle-${id}`}
            />
          </span>
        </div>
      )}
      {nextRun !== null && (
        <div className="automation-item__line" data-testid={`automation-next-run-${id}`}>
          <CalendarClock size={10} aria-hidden="true" />
          <span className="automation-item__line-text">{nextRun}</span>
        </div>
      )}
    </>
  );
}
