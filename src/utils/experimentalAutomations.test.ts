/**
 * Which automation code asks for the experimental switch (#5818, slice 11).
 * Everything about automations graduated except the "Run local process" step
 * (maintainer decision 2026-11-23), so only what shows, offers or runs that step
 * may ask. A new entry here needs a reason that names that step.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, it } from "vitest";

const SRC = join(__dirname, "..");
const GATE = /useExperimentalFeatures\(|experimentalFeaturesOn\(|experimentalFeaturesEnabled/;

/** Code that shows, starts or runs automations, schedules included. */
const AUTOMATION_CODE =
  /^(components\/(Automation\w*|CommandPalette|Recording|Schedules|WorkflowSidebar|Terminal)\/|store\/(slices\/)?(automation|macro|workflow|recording|schedule|localProcess)|services\/(automation|macro|workflow|commands|contextCommands|localProcess)|hooks\/useKeyboardShortcuts|utils\/(automation|localProcess))/i;

const ALLOWED: Record<string, string> = {
  "components/AutomationEditor/AddStepMenu.tsx": "offers the Run local process step",
  "components/AutomationEditor/AutomationEditorDialog.tsx": "Save and run says it cannot run",
  "components/AutomationEditor/StepRow.tsx": "says a Run local process step will not run",
  "components/AutomationSidebar/AutomationSidebar.tsx": "says a row cannot run",
  "components/Automations/RunTargetsDialog.tsx": "says that it cannot run",
  "components/CommandPalette/CommandPalette.tsx": "says an entry cannot run",
  "components/Schedules/ScheduleEditorDialog.tsx": "offers no automation that reaches the step",
  "components/Schedules/useScheduleLabels.ts": "says why a schedule of one will not run",
  "store/localProcessRefusal.ts": "refuses a run that reaches the step, whatever starts it",
  "store/scheduledRuns.ts": "skips a due run that reaches the step",
  "store/slices/workflowRunOnTarget.ts": "refuses the spawn when the switch went off mid-run",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

it("only the Run local process step is behind the experimental switch", () => {
  const gated = sources(SRC)
    .map((path) => [relative(SRC, path).split(sep).join("/"), path] as const)
    .filter(([name]) => AUTOMATION_CODE.test(name))
    .filter(([, path]) => GATE.test(readFileSync(path, "utf8")))
    .map(([name]) => name);
  expect(gated.sort()).toEqual(Object.keys(ALLOWED).sort());
});
