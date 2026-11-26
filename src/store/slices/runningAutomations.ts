/**
 * Which automations run in this window, for the questions asked before one is
 * stopped (#6042). Runs that type keys replace each other; step-by-step runs replace
 * each other only in the same terminal; two runs never type into one terminal.
 */
import { currentWorkflowRunView } from "../workflowRunBridge";
import { stepProgress, typedProgress } from "@/utils/runProgress";
import type { AppState } from "../appStore";
import { macroTargetLabel } from "./macroRunHistory";

/** An automation that runs, and where. */
export interface RunningAutomation {
  name: string;
  where: string;
  /** "at step 2 of 3", "50 % typed". */
  progress: string;
  /** The terminal it types into. */
  tabId: string;
  /** The step-by-step run, by id. */
  runId?: string;
  /** Whether it types keys rather than running steps. */
  typesKeys: boolean;
}

/** The runs that type keys, one per terminal. */
function typingRuns(state: AppState): RunningAutomation[] {
  const { macroPlayback } = state;
  return (macroPlayback ? (macroPlayback.targetTabIds ?? [macroPlayback.tabId]) : []).map(
    (tabId) => ({
      name: macroPlayback?.macroName ?? "",
      where: macroTargetLabel(state, tabId),
      progress: typedProgress(
        macroPlayback?.targetProgress?.[tabId] ?? macroPlayback?.played ?? 0,
        macroPlayback?.total ?? 0
      ),
      tabId,
      typesKeys: true,
    })
  );
}

/** The step-by-step runs. */
function stepRuns(state: AppState): RunningAutomation[] {
  return currentWorkflowRunView().runs.map((run) => ({
    name: run.workflowName,
    where: run.label || macroTargetLabel(state, run.tabId),
    progress: `at ${stepProgress(run.completed, run.total).toLowerCase()}`,
    tabId: run.tabId,
    runId: run.runId,
    typesKeys: false,
  }));
}

/**
 * The runs a new one of this kind on `targets` would stop (#6042): every one that
 * types keys when it types keys (one playback at a time), and every other run in
 * the same terminals, which would otherwise type into them at the same time.
 * Step-by-step runs on other terminals go on side by side.
 */
export function runsReplacedBy(
  state: AppState,
  typesKeys: boolean,
  targets: readonly string[]
): RunningAutomation[] {
  const here = (run: RunningAutomation) => targets.includes(run.tabId);
  return typesKeys
    ? [...typingRuns(state), ...stepRuns(state).filter(here)]
    : [...stepRuns(state).filter(here), ...typingRuns(state).filter(here)];
}
