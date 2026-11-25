/**
 * Pure formatting helpers of the one Automation history panel (#5818, slice 9).
 * Every run record, whether it came from a macro playback, a workflow run or
 * the migration, reads the same way: one set of origin labels, one status
 * wording, one way to name the terminals it ran on.
 */
import type { StatusTone } from "@/components/ui";
import { stepKindLabel, stepSummary } from "@/components/AutomationEditor/stepText";
import { t, tf, type MessageId } from "@/i18n/catalog";
import { isMacroShaped } from "@/store/slices/automationViews";
import type { AttemptSummary } from "@/components/Schedules/scheduleStatus";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import type { AutomationRunStatus } from "@/types/generated/AutomationRunStatus";
import { formatElapsed } from "@/utils/formatters";
import { compareNames } from "@/utils/locale";
import { typedProgress } from "@/utils/runProgress";

/** Who or what started a run; a schedule by its name (A-039). */
export function automationRunStarter(origin: AutomationRunOrigin, schedule?: string): string {
  switch (origin) {
    case "manual":
    case "palette":
      return t("automationHistory.origin.you");
    case "hotkey":
      return t("automationHistory.origin.hotkey");
    case "on-connect":
    case "on-disconnect":
    case "on-output-match":
      return t("automationHistory.origin.trigger");
    case "scheduled":
      return schedule === undefined
        ? t("automationHistory.origin.schedule")
        : tf("automationHistory.origin.scheduleNamed", { name: schedule });
    case "run-by-automation":
      return t("automationHistory.origin.automation");
  }
}

/**
 * The detail that tells two runs with the same origin label apart (where it
 * started from, which trigger fired), or `null` when the label says it all.
 */
export function automationRunOriginDetail(origin: AutomationRunOrigin): string | null {
  switch (origin) {
    case "palette":
      return t("automationHistory.via.palette");
    case "on-connect":
      return t("automationHistory.via.onConnect");
    case "on-disconnect":
      return t("automationHistory.via.onDisconnect");
    case "on-output-match":
      return t("automationHistory.via.onOutputMatch");
    default:
      return null;
  }
}

/** The {@link StatusTone} of a run's outcome. */
export function automationRunTone(status: AutomationRunStatus): StatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "cancelled":
      return "warning";
  }
}

/** The run's outcome in words; the wire value stays `cancelled`. */
export function automationRunStatusLabel(status: AutomationRunStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
  }
}

/** The run's duration as a compact string (`2s`, `1m 5s`); empty when unknown. */
export function automationRunDuration(run: Pick<AutomationRun, "startedAt" | "endedAt">): string {
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return formatElapsed(Math.round(ms / 1000));
}

/** The terminals a run went to: every label it recorded, else none. */
export function automationRunTargets(run: AutomationRun): string[] {
  if (run.targetLabels && run.targetLabels.length > 0) return run.targetLabels;
  return run.targetLabel ? [run.targetLabel] : [];
}

/** "1 step failed, the run went on". */
export function toleratedText(count: number): string {
  return `${count} step${count === 1 ? "" : "s"} failed, the run went on`;
}

/** The automation of a run as it is now, if it still exists. */
type RunAutomation = Pick<Automation, "steps" | "triggers" | "parameters" | "legacy"> | undefined;

/**
 * Whether the run counted what was typed (keys and pastes), not steps: the
 * automation only types. Its numbers mean nothing to a user then (A-003).
 */
function countsTyped(run: Pick<AutomationRun, "total">, automation: RunAutomation): boolean {
  return (
    automation !== undefined &&
    isMacroShaped(automation as Automation) &&
    run.total !== automation.steps.length
  );
}

/** How far the run got, e.g. "3 of 4 steps". */
export function automationRunProgress(
  run: Pick<AutomationRun, "stepsCompleted" | "total">,
  automation?: RunAutomation
): string {
  if (countsTyped(run, automation)) {
    return typedProgress(run.stepsCompleted, run.total);
  }
  return `${run.stepsCompleted} of ${run.total} step${run.total === 1 ? "" : "s"}`;
}

/**
 * How the run ended and where, e.g. `Failed at step 2 of 5 (Run command: make)`.
 * The step is named only while the automation has not changed since: another step
 * may stand there now.
 */
export function automationRunOutcome(run: AutomationRun, automation?: Automation): string {
  const status = automationRunStatusLabel(run.status);
  const tolerated = run.continuedFailures ? ` · ${toleratedText(run.continuedFailures)}` : "";
  if (run.status !== "failed") return status + tolerated;
  if (countsTyped(run, automation)) {
    return `${status}, ${automationRunProgress(run, automation)}${tolerated}`;
  }
  if (run.failedStepIndex === undefined) return status + tolerated;
  const at = `${status} at step ${run.failedStepIndex + 1} of ${run.total}`;
  const unchanged = automation && Date.parse(automation.updatedAt) <= Date.parse(run.startedAt);
  const step = unchanged ? automation.steps[run.failedStepIndex] : undefined;
  const what = step ? [stepKindLabel(step.kind), stepSummary(step)].filter(Boolean).join(": ") : "";
  return `${at}${what ? ` (${what})` : ""}${tolerated}`;
}

/** What each kind of failure asks for, by words of its stored reason. */
const NEXT_STEPS: readonly [RegExp, MessageId][] = [
  [/nobody pressed Continue/, "automationHistory.next.continue"],
  [/nobody (is|was) there/, "automationHistory.next.attended"],
  [
    /no longer connected|stopped accepting input|closed or disconnected/,
    "automationHistory.next.reconnect",
  ],
  [/wait-for-output timed out/, "automationHistory.next.pattern"],
  [
    /is not authorized|was not allowed to run|You did not allow|is not an allowed program/,
    "automationHistory.next.allow",
  ],
  [/exited with code/, "automationHistory.next.program"],
];

/** What to do about a failed run, or `null` when its reason says it already. */
export function nextStepAfter(run: Pick<AutomationRun, "status" | "error">): string | null {
  if (run.status !== "failed" || !run.error) return null;
  const found = NEXT_STEPS.find(([words]) => words.test(run.error ?? ""));
  return found ? t(found[1]) : null;
}

/** What to do about a scheduled time at which nothing ran (B-033), or `null`. */
export function nextStepAfterGap(gap: Pick<AttemptSummary, "kind" | "reason">): string | null {
  if (gap.kind === "missed") return t("schedule.next.missed");
  const closed = t("schedule.skip.noneOpen");
  return gap.kind === "skipped" && gap.reason?.startsWith(closed)
    ? t("schedule.next.closed")
    : null;
}

/** The runs of one automation (`null`: every run), in the order given. */
export function runsOfAutomation(
  runs: readonly AutomationRun[],
  automationId: string | null
): AutomationRun[] {
  return automationId ? runs.filter((r) => r.automationId === automationId) : [...runs];
}

/** One choice of the "filter by automation" select. */
export interface AutomationFilterOption {
  /** The automation id. */
  value: string;
  /** Its current name, else the name of its newest run. */
  label: string;
}

/**
 * The automations the history can be narrowed to: every automation with at
 * least one entry (a deleted one too, by the name its newest run recorded),
 * sorted by name. `names` maps ids to current names, so a renamed automation
 * shows its new name.
 */
export function automationFilterOptions(
  runs: readonly Pick<AutomationRun, "automationId" | "automationName">[],
  names: ReadonlyMap<string, string>
): AutomationFilterOption[] {
  const seen = new Map<string, string>();
  for (const run of runs) {
    if (!seen.has(run.automationId)) {
      seen.set(run.automationId, names.get(run.automationId) ?? run.automationName);
    }
  }
  return [...seen]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => compareNames(a.label, b.label));
}
