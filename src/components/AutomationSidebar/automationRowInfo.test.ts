import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import {
  armedMarkerDescription,
  automaticTriggers,
  automationRowTooltip,
  summarizeRuns,
  triggerSummary,
  triggersArmed,
} from "./automationRowInfo";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    name: "Deploy",
    tags: [],
    steps: [],
    triggers: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "r1",
    automationId: "a1",
    automationName: "Deploy",
    startedAt: "2026-11-24T10:00:00Z",
    endedAt: "2026-11-24T10:00:01Z",
    status: "completed",
    stepsCompleted: 1,
    total: 1,
    origin: "manual",
    ...overrides,
  };
}

const names: Record<string, string> = { c1: "prod", c2: "db", c3: "web" };
const nameOf = (id: string) => names[id];

describe("triggers", () => {
  it("counts only connection-bound automatic triggers, never a hotkey", () => {
    const a = automation({
      triggers: [
        { kind: "hotkey", binding: "Ctrl+Alt+D" },
        { kind: "on-connect", connectionIds: [] },
        { kind: "on-disconnect", connectionIds: ["c1"] },
      ],
    });
    expect(automaticTriggers(a).map((x) => x.kind)).toEqual(["on-disconnect"]);
  });

  it("is armed unless it was switched off", () => {
    expect(triggersArmed(automation())).toBe(true);
    expect(triggersArmed(automation({ triggersEnabled: false }))).toBe(false);
  });

  it("summarizes how it is launched, with the first connections and a count", () => {
    expect(triggerSummary(automation(), nameOf)).toBe("Manual");
    const a = automation({
      triggers: [
        { kind: "on-connect", connectionIds: ["c1", "c2", "c3"] },
        { kind: "hotkey", binding: "Ctrl+Alt+D" },
        { kind: "on-disconnect", connectionIds: ["gone"] },
      ],
    });
    expect(triggerSummary(a, nameOf)).toBe(
      "On connect · prod, db +1; Hotkey Ctrl+Alt+D; On disconnect · Unknown connection"
    );
  });

  it("says what the marker means, and that Off is about the trigger (R-077)", () => {
    const a = automation({
      triggers: [
        { kind: "on-output-match", connectionIds: ["c1"], pattern: "x" },
        { kind: "on-connect", connectionIds: ["c2"] },
      ],
    });
    expect(armedMarkerDescription(a, nameOf)).toBe(
      "Runs automatically: on output match of prod; on connect of db"
    );
    expect(armedMarkerDescription({ ...a, triggersEnabled: false }, nameOf)).toBe(
      "Trigger off, will not run automatically: on output match of prod; on connect of db"
    );
  });
});

describe("row tooltip", () => {
  it("lists trigger, typed lines, last run and tags, never 'macro' or 'workflow'", () => {
    const a = automation({
      tags: ["ops", "release"],
      steps: [
        {
          kind: "type-keys",
          chunks: [{ data: "git pull\r", delayMs: 0 }],
          timing: "recorded",
          recorded: true,
        },
      ],
    });
    const lines = automationRowTooltip(a, nameOf, run({ targetLabels: ["web-1"], targetCount: 1 }));
    expect(lines[0]).toBe("Manual");
    expect(lines[1]).toBe("Types:");
    expect(lines[2]).toContain("git pull");
    expect(lines[3]).toMatch(/^Last run: .* on web-1$/);
    expect(lines[4]).toBe("Tags: ops, release");
    expect(lines.join(" ")).not.toMatch(/macro|workflow/i);
  });

  it("previews the first step and counts the rest", () => {
    const a = automation({
      steps: [
        { kind: "send-command", command: "make build" },
        { kind: "wait", delayMs: 500 },
        { kind: "wait", delayMs: 500 },
      ],
    });
    expect(automationRowTooltip(a, nameOf)[1]).toBe("Run command: make build (+2 more)");
    expect(automationRowTooltip(automation({ steps: a.steps.slice(0, 1) }), nameOf)[1]).toBe(
      "Run command: make build"
    );
  });

  it("counts the terminals of a multi-terminal run and copes with none recorded", () => {
    const many = automationRowTooltip(
      automation(),
      nameOf,
      run({ targetLabels: ["a", "b"], targetCount: 2 })
    );
    expect(many[1]).toMatch(/on 2 terminals$/);
    const none = automationRowTooltip(automation(), nameOf, run());
    expect(none[1]).toMatch(/^Last run: /);
    expect(none[1]).not.toContain("terminal");
  });

  it("says nothing about a nested automation it cannot name", () => {
    const a = automation({ steps: [{ kind: "run-automation", automationId: "a2" }] });
    expect(automationRowTooltip(a, nameOf)).toEqual(["Manual"]);
  });
});

describe("summarizeRuns", () => {
  const at = (minute: number) => `2026-11-24T10:${String(minute).padStart(2, "0")}:00Z`;

  it("picks the newest run whatever the order", () => {
    const runs = [run({ id: "old", endedAt: at(1) }), run({ id: "new", endedAt: at(5) })];
    expect(summarizeRuns(runs).get("a1")?.last.id).toBe("new");
    expect(summarizeRuns([...runs].reverse()).get("a1")?.last.id).toBe("new");
  });

  it.each(["scheduled", "on-connect", "on-disconnect", "on-output-match"] as const)(
    "marks a failed %s run until something completes after it",
    (origin) => {
      const failed = run({ id: "f", origin, status: "failed", endedAt: at(2) });
      expect(summarizeRuns([failed]).get("a1")?.failedUnattended).toBe(true);
      const ok = run({ id: "ok", endedAt: at(3) });
      expect(summarizeRuns([ok, failed]).get("a1")?.failedUnattended).toBe(false);
      const earlier = run({ id: "before", endedAt: at(1) });
      expect(summarizeRuns([failed, earlier]).get("a1")?.failedUnattended).toBe(true);
    }
  );

  it("keeps the mark when a later run by hand also failed or was canceled", () => {
    const failed = run({ id: "f", origin: "scheduled", status: "failed", endedAt: at(2) });
    for (const status of ["failed", "cancelled"] as const) {
      const later = run({ id: "l", status, endedAt: at(4) });
      expect(summarizeRuns([later, failed]).get("a1")?.failedUnattended).toBe(true);
    }
  });

  it("does not mark a run the user started: it reported its failure right away", () => {
    for (const origin of ["manual", "palette", "hotkey", "run-by-automation"] as const) {
      const failed = run({ origin, status: "failed" });
      expect(summarizeRuns([failed]).get("a1")?.failedUnattended).toBe(false);
    }
  });

  it("keeps automations apart", () => {
    const map = summarizeRuns([run(), run({ id: "r2", automationId: "a2" })]);
    expect([...map.keys()].sort()).toEqual(["a1", "a2"]);
  });
});
