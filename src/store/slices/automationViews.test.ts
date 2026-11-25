/**
 * The thin adapters between the single automation store and the legacy macro
 * and workflow views (#5818, slice 4).
 */
import { describe, it, expect } from "vitest";

import type { Automation } from "@/types/generated/Automation";
import type { Macro } from "@/types/macro";
import type { Workflow } from "@/types/workflow";

import {
  automationToMacro,
  automationToWorkflow,
  isMacroShaped,
  libraryViews,
  macroToAutomation,
  workflowToAutomation,
} from "./automationViews";

const base = { tags: [], createdAt: "c", updatedAt: "u" };

const typed: Automation = {
  ...base,
  id: "m1",
  name: "List",
  steps: [
    {
      kind: "type-keys",
      chunks: [
        { data: "ls", delayMs: 0 },
        { data: "\r", delayMs: 120 },
      ],
      timing: "fixed",
      fixedDelayMs: 10,
      recorded: true,
    },
  ],
  triggers: [],
  legacy: { from: "macro", version: 1 },
};

const deploy: Automation = {
  ...base,
  id: "w1",
  name: "Deploy",
  steps: [
    { kind: "send-command", command: "make" },
    {
      kind: "conditional",
      condition: { left: "${env}", op: "eq", right: "prod" },
      then: [{ kind: "run-automation", automationId: "m1" }],
      else: [{ kind: "wait", delayMs: 5 }],
    },
    {
      kind: "loop",
      loop: { kind: "count", count: 2 },
      body: [{ kind: "run-automation", automationId: "m1" }],
    },
  ],
  triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+D" }],
  parameters: [{ name: "env", type: "string" }],
  triggersEnabled: false,
};

describe("isMacroShaped", () => {
  it("puts typing-only, trigger-free, parameter-free automations under Macros", () => {
    expect(isMacroShaped(typed)).toBe(true);
    expect(isMacroShaped(deploy)).toBe(false);
    expect(isMacroShaped({ ...typed, triggers: [{ kind: "hotkey", binding: "F9" }] })).toBe(false);
    expect(isMacroShaped({ ...typed, parameters: [{ name: "x", type: "string" }] })).toBe(false);
    const retried = { ...typed, steps: [{ ...typed.steps[0], retry: { count: 1, delayMs: 0 } }] };
    expect(isMacroShaped(retried as Automation)).toBe(false);
  });

  it("decides an empty automation by its provenance", () => {
    expect(isMacroShaped({ ...typed, steps: [] })).toBe(true);
    expect(isMacroShaped({ ...typed, steps: [], legacy: undefined })).toBe(false);
  });

  it("shows every automation in exactly one view", () => {
    const { macros, workflows } = libraryViews([typed, deploy]);
    expect(macros.map((m) => m.id)).toEqual(["m1"]);
    expect(workflows.map((w) => w.id)).toEqual(["w1"]);
  });
});

describe("macro view", () => {
  it("flattens the chunks byte for byte", () => {
    expect(automationToMacro(typed)).toEqual({
      ...base,
      id: "m1",
      name: "List",
      description: undefined,
      steps: [
        { data: "ls", delayMs: 0 },
        { data: "\r", delayMs: 120 },
      ],
    });
  });

  it("round-trips an untouched macro to the stored steps", () => {
    expect(macroToAutomation(automationToMacro(typed), typed)).toEqual(typed);
  });

  it("keeps the saved timing when the chunks change", () => {
    const edited: Macro = { ...automationToMacro(typed), steps: [{ data: "pwd\r", delayMs: 0 }] };
    expect(macroToAutomation(edited, typed).steps).toEqual([
      {
        kind: "type-keys",
        chunks: [{ data: "pwd\r", delayMs: 0 }],
        timing: "fixed",
        fixedDelayMs: 10,
        recorded: true,
      },
    ]);
  });

  it("saves a new macro as one recorded type-keys step without provenance", () => {
    const fresh: Macro = { ...base, id: "new", name: "N", steps: [{ data: "x", delayMs: 0 }] };
    const saved = macroToAutomation(fresh);
    expect(saved.triggers).toEqual([]);
    expect(saved.legacy).toBeUndefined();
    expect(saved.steps).toEqual([
      {
        kind: "type-keys",
        chunks: [{ data: "x", delayMs: 0 }],
        timing: "recorded",
        recorded: true,
      },
    ]);
  });
});

describe("workflow view", () => {
  it("reads run-automation as run-macro, everywhere, and always offers manual", () => {
    const view = automationToWorkflow(deploy);
    expect(view.triggers).toEqual([{ kind: "manual" }, { kind: "hotkey", binding: "Ctrl+Alt+D" }]);
    expect(view.triggersEnabled).toBe(false);
    expect(view.parameters).toEqual(deploy.parameters);
    expect(view.steps[1]).toMatchObject({
      kind: "conditional",
      then: [{ kind: "run-macro", macroId: "m1" }],
      else: [{ kind: "wait", delayMs: 5 }],
    });
    expect(view.steps[2]).toMatchObject({ body: [{ kind: "run-macro", macroId: "m1" }] });
  });

  it("round-trips to the stored automation", () => {
    expect(workflowToAutomation(automationToWorkflow(deploy), deploy)).toEqual(deploy);
  });

  it("drops manual and omits defaults when saving", () => {
    const workflow: Workflow = {
      ...base,
      id: "w2",
      name: "W",
      steps: [],
      triggers: [{ kind: "manual" }],
      parameters: [],
    };
    const saved = workflowToAutomation(workflow);
    expect(saved).toEqual({
      ...base,
      id: "w2",
      name: "W",
      description: undefined,
      steps: [],
      triggers: [],
    });
  });
});
