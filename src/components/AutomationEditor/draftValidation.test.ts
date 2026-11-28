import { describe, expect, it } from "vitest";
import { automationWith } from "@/test/automationEditorHarness";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import { toDraft } from "./automationDraft";
import { draftErrors, draftValues, firstStepProblem, missingSummary } from "./draftValidation";

const condition = { left: " ", op: "eq" as const, right: "" };
const errorsOf = (steps: AutomationStep[], triggers: AutomationTrigger[] = []) => {
  const draft = toDraft(automationWith(steps, { triggers }));
  return { errors: draftErrors(draft), values: draftValues(draft), draft };
};

describe("fields a step cannot do without (A-022)", () => {
  it.each<[string, AutomationStep, AutomationStep]>([
    ["command", { kind: "send-command", command: " " }, { kind: "send-command", command: "ls" }],
    ["script", { kind: "run-script", script: "" }, { kind: "run-script", script: "ls" }],
    [
      "script",
      { kind: "run-script", script: "" },
      { kind: "run-script", script: "", sourcePath: "/x.sh" },
    ],
    [
      "automationId",
      { kind: "run-automation", automationId: "" },
      // One that is missing says so in its row; it does not keep a rename from being saved.
      { kind: "run-automation", automationId: "gone" },
    ],
    [
      "program",
      { kind: "run-local-process", program: "", args: [] },
      { kind: "run-local-process", program: "make", args: [] },
    ],
    [
      "pattern",
      { kind: "wait-for-output", pattern: "" },
      { kind: "wait-for-output", pattern: " " },
    ],
    [
      "left",
      { kind: "conditional", condition, then: [] },
      { kind: "conditional", condition: { ...condition, left: "a" }, then: [] },
    ],
    [
      "left",
      { kind: "loop", loop: { kind: "while", condition }, body: [] },
      { kind: "loop", loop: { kind: "count", count: 0 }, body: [] },
    ],
  ])("%s", (field, empty, filled) => {
    const { errors, values, draft } = errorsOf([empty]);
    const path = `steps.${draft.steps[0].uid}.${field}`;
    expect(Object.keys(errors)).toEqual([path]);
    // The same path in the values, or leaving the field would not show it.
    const steps = values.steps as Record<string, Record<string, unknown>>;
    expect(steps[draft.steps[0].uid]).toHaveProperty(field);
    expect(errorsOf([filled]).errors).toEqual({});
  });

  it("a hotkey without keys", () => {
    const trigger = { kind: "hotkey" as const, binding: " " };
    const { errors, draft } = errorsOf([{ kind: "wait", delayMs: 1 }], [trigger]);
    expect(errors).toEqual({ [`triggers.${draft.triggers[0].uid}.binding`]: "Press the keys." });
  });

  it("a wait for the user needs no wording", () => {
    expect(errorsOf([{ kind: "wait-for-user" }]).errors).toEqual({});
  });
});

it.each<[Record<string, string>, string | null]>([
  [{}, null],
  [{ name: "x" }, "To save: give it a name."],
  [{ name: "x", stepList: "x" }, "To save: give it a name and add at least one step."],
  [
    { name: "x", "steps.a.command": "x", "triggers.b.binding": "x" },
    "To save: give it a name and complete the steps and the triggers.",
  ],
])("says what is missing: %j", (errors, text) => expect(missingSummary(errors)).toBe(text));

describe("the save hint names the step to fix (#6183, editor-4)", () => {
  it("names the first step with a problem, its kind and what is wrong", () => {
    const draft = toDraft(
      automationWith([
        { kind: "send-command", command: "ls" },
        { kind: "type-keys", chunks: [{ data: "a", delayMs: 0 }] },
      ])
    );
    // What the user typed into the keys field: an escape the format does not know.
    draft.steps[1].keys![0] = { ...draft.steps[1].keys![0], text: "\\q" };
    const errors = draftErrors(draft);
    const problem = firstStepProblem(draft, errors);
    expect(problem).toMatchObject({ uid: draft.steps[1].uid, number: "2", kind: "Type keys" });
    // The first clause of the error, without its long "use …" advice.
    expect(problem?.message).toBe('unknown escape "\\q"');
    expect(missingSummary(errors, problem)).toBe(
      'To save: fix step 2 (Type keys): unknown escape "\\q".'
    );
  });

  it("numbers a step inside another step as 1.1", () => {
    const { errors, draft } = errorsOf([
      {
        kind: "conditional",
        condition: { left: "a", op: "eq", right: "b" },
        then: [{ kind: "send-command", command: " " }],
      },
    ]);
    const problem = firstStepProblem(draft, errors);
    expect(problem?.number).toBe("1.1");
    expect(problem?.kind).toBe("Run command");
  });

  it("keeps the name and the triggers in the same sentence", () => {
    const { errors, draft } = errorsOf([{ kind: "send-command", command: " " }]);
    const all = { ...errors, name: "Name is required." };
    expect(missingSummary(all, firstStepProblem(draft, all))).toBe(
      "To save: give it a name and fix step 1 (Run command): enter the command."
    );
  });

  it("is null without a step problem", () => {
    const { errors, draft } = errorsOf([{ kind: "send-command", command: "ls" }]);
    expect(firstStepProblem(draft, { ...errors, name: "x" })).toBeNull();
  });
});
