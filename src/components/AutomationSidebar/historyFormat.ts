/**
 * Pure formatting helpers of the one Automation history panel (#5818, slice 9).
 * Every run record, whether it came from a macro playback, a workflow run or
 * the migration, reads the same way: one set of origin labels, one status
 * wording, one way to name the terminals it ran on.
 */
import type { StatusTone } from "@/components/ui";
import { t } from "@/i18n/catalog";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { AutomationRunOrigin } from "@/types/generated/AutomationRunOrigin";
import type { AutomationRunStatus } from "@/types/generated/AutomationRunStatus";
import { formatElapsed } from "@/utils/formatters";
import { compareNames } from "@/utils/locale";

/**
 * Who or what started a run, in the unified wording: "Run by you" (by hand or
 * from the command palette), "Run by hotkey", "Run by trigger" (on connect,
 * on disconnect, on output match), "Run by schedule" and "Run by another
 * automation" (a `run-automation` step).
 */
export function automationRunOriginLabel(origin: AutomationRunOrigin): string {
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
      return t("automationHistory.origin.schedule");
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

/** The run's outcome in words (US spelling: the wire value stays `cancelled`). */
export function automationRunStatusLabel(status: AutomationRunStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Canceled";
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

/** How far the run got, e.g. "3 of 4 steps". */
export function automationRunProgress(
  run: Pick<AutomationRun, "stepsCompleted" | "total">
): string {
  return `${run.stepsCompleted} of ${run.total} step${run.total === 1 ? "" : "s"}`;
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
 * least one run (a deleted one too, by the name its newest run recorded),
 * sorted by name. `names` maps ids to current names, so a renamed automation
 * shows its new name.
 */
export function automationFilterOptions(
  runs: readonly AutomationRun[],
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
