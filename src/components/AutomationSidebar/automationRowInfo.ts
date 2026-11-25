/**
 * What an automation row and its tooltip say (#5818, slice 6). All **pure**.
 * The row shows the name, the user's description and state markers only
 * (#5757); how it is launched, what it types first, its last run and its tags
 * are tooltip lines.
 */
import { tagsLine } from "@/components/SidebarListItem/rowTooltip";
import {
  stepKindLabel,
  stepSummary,
  triggerKindLabel,
} from "@/components/AutomationEditor/stepMeta";
import { MAX_PREVIEW_LINES, macroPreviewLines } from "@/components/AutomationEditor/keysFormat";
import { t, tf } from "@/i18n/catalog";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { formatRelativeTime } from "@/utils/formatters";
import { automationRunTargets } from "./historyFormat";

/** How many bound connection names a trigger lists before collapsing to "+N". */
const MAX_SUMMARY_CONNECTIONS = 2;

/** Resolves a saved connection id to its name. */
export type ConnectionName = (connectionId: string) => string | undefined;

/** Triggers that run an automation by themselves once a bound session acts. */
type SessionTrigger = Exclude<AutomationTrigger, { kind: "hotkey" }>;

/** A trigger of a kind this build knows; one a newer build wrote never fires. */
function isSessionTrigger(trigger: AutomationTrigger): trigger is SessionTrigger {
  switch (trigger.kind) {
    case "on-connect":
    case "on-disconnect":
    case "on-output-match":
      return true;
    default:
      return false;
  }
}

/**
 * The automation's automatic triggers (#5635): the ones that run it, and may
 * type into a terminal, without the user starting it. A trigger bound to no
 * connection never fires, so it does not count; a hotkey is the user.
 */
export function automaticTriggers(automation: Automation): SessionTrigger[] {
  return automation.triggers.filter(
    (trigger): trigger is SessionTrigger =>
      isSessionTrigger(trigger) && trigger.connectionIds.length > 0
  );
}

/** Whether the automatic triggers may fire; an absent flag means armed (#5674). */
export function triggersArmed(automation: Automation): boolean {
  return automation.triggersEnabled !== false;
}

/** The bound connections' names, the first few listed and the rest counted. */
function connectionList(ids: string[], connectionName: ConnectionName): string {
  const names = ids.map((id) => connectionName(id) ?? "Unknown connection");
  const shown = names.slice(0, MAX_SUMMARY_CONNECTIONS).join(", ");
  const rest = names.length - MAX_SUMMARY_CONNECTIONS;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * How the automation is launched and what it watches (#5635), e.g.
 * `On output match · prod`; `Manual` without a trigger.
 */
export function triggerSummary(automation: Automation, connectionName: ConnectionName): string {
  const watched = new Set<AutomationTrigger>(automaticTriggers(automation));
  const parts: string[] = [];
  for (const trigger of automation.triggers) {
    if (trigger.kind === "hotkey") {
      if (trigger.binding) parts.push(`${triggerKindLabel("hotkey")} ${trigger.binding}`);
    } else if (watched.has(trigger)) {
      parts.push(
        `${triggerKindLabel(trigger.kind)} · ${connectionList(trigger.connectionIds, connectionName)}`
      );
    }
  }
  return parts.length > 0 ? parts.join("; ") : triggerKindLabel("manual");
}

/**
 * The Armed/Off marker's description (#5635, #5674), naming what each automatic
 * trigger watches: `Runs automatically: on output match of prod`, or, switched
 * off, `Trigger off, will not run automatically: …` (R-077: "Off" is about the
 * trigger, not the automation).
 */
export function armedMarkerDescription(
  automation: Automation,
  connectionName: ConnectionName
): string {
  const triggers = automaticTriggers(automation)
    .map(
      (trigger) =>
        `${triggerKindLabel(trigger.kind).toLowerCase()} of ${connectionList(
          trigger.connectionIds,
          connectionName
        )}`
    )
    .join("; ");
  return triggersArmed(automation)
    ? tf("automation.armed.on", { triggers })
    : tf("automation.armed.off", { triggers });
}

/** What the automation does first, as tooltip lines. */
function firstStepLines(automation: Automation): string[] {
  const [first] = automation.steps;
  if (!first) return [];
  if (first.kind === "type-keys") {
    const lines = macroPreviewLines(
      automation.steps.flatMap((step) => (step.kind === "type-keys" ? step.chunks : []))
    );
    if (lines.length === 0) return [];
    return [
      t("macro.tooltip.types"),
      ...lines.slice(0, MAX_PREVIEW_LINES),
      ...(lines.length > MAX_PREVIEW_LINES ? ["…"] : []),
    ];
  }
  // A nested automation is named by the library, which this has not got.
  if (first.kind === "run-automation") return [];
  const more = automation.steps.length - 1;
  const line = `${stepKindLabel(first.kind)}: ${stepSummary(first)}`;
  return [more > 0 ? tf("automation.tooltip.moreSteps", { line, count: more }) : line];
}

/**
 * The row's tooltip lines (#5757): how it is launched and what it watches, what
 * it does first, when and where it last ran, its tags.
 */
export function automationRowTooltip(
  automation: Automation,
  connectionName: ConnectionName,
  lastRun?: AutomationRun
): string[] {
  const lines = [triggerSummary(automation, connectionName), ...firstStepLines(automation)];
  if (lastRun) {
    const when = formatRelativeTime(lastRun.endedAt);
    const targets = automationRunTargets(lastRun);
    const count = lastRun.targetCount ?? targets.length;
    const target = targets.length === 1 ? targets[0] : `${count} terminal${count === 1 ? "" : "s"}`;
    lines.push(
      count > 0
        ? tf("macro.tooltip.lastRun", { when, target })
        : tf("automation.tooltip.lastRun", { when })
    );
  }
  const tags = tagsLine(automation.tags);
  if (tags) lines.push(tags);
  return lines;
}

/** Runs the user did not start by hand, so they did not see them fail. */
const UNATTENDED_ORIGINS: ReadonlySet<AutomationRunOrigin> = new Set([
  "on-connect",
  "on-disconnect",
  "on-output-match",
  "scheduled",
]);

/** What the run history says about one automation. */
export interface AutomationRunSummary {
  /** Its most recent run. */
  last: AutomationRun;
  /**
   * The latest run the user did not start failed, and nothing has completed
   * since: the row's Failed marker. A run started by hand reports its failure
   * right away, so it does not mark the row.
   */
  failedUnattended: boolean;
}

/**
 * Summarize the history per automation. Picks by `endedAt`, so the result does
 * not depend on the order the history arrives in.
 */
export function summarizeRuns(runs: readonly AutomationRun[]): Map<string, AutomationRunSummary> {
  const ended = (run: AutomationRun) => Date.parse(run.endedAt) || 0;
  const byId = new Map<string, AutomationRun[]>();
  for (const run of runs) {
    const list = byId.get(run.automationId);
    if (list) list.push(run);
    else byId.set(run.automationId, [run]);
  }
  const out = new Map<string, AutomationRunSummary>();
  for (const [id, list] of byId) {
    const newestFirst = [...list].sort((a, b) => ended(b) - ended(a));
    const unattended = newestFirst.find((r) => UNATTENDED_ORIGINS.has(r.origin));
    const completed = newestFirst.find((r) => r.status === "completed");
    out.set(id, {
      last: newestFirst[0],
      failedUnattended:
        unattended?.status === "failed" &&
        (completed === undefined || ended(completed) < ended(unattended)),
    });
  }
  return out;
}
