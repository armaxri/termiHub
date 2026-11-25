/**
 * The frontend hop of #6009: an automation written by a newer build survives
 * the editor, the Armed switch, Duplicate and the macro and workflow views, and
 * a kind this build does not know is listed but never run. The fixture is the
 * one the Rust store tests read, so file → IPC → editor → IPC → file is covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));
const saved = vi.hoisted(() => [] as import("@/types/generated/Automation").Automation[]);
const library = vi.hoisted(() => [] as import("@/types/generated/Automation").Automation[]);
vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve(library)),
  saveAutomation: vi.fn((a: import("@/types/generated/Automation").Automation) => {
    saved.push(structuredClone(a));
    return Promise.resolve(a);
  }),
  getAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  listAutomationRuns: vi.fn(() => Promise.resolve([])),
  recordAutomationRun: vi.fn(() => Promise.resolve([])),
  clearAutomationRunHistory: vi.fn(() => Promise.resolve([])),
}));

import { runAutomation } from "@/services/automationRunner";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import {
  automationToMacro,
  automationToWorkflow,
  macroToAutomation,
  workflowToAutomation,
} from "@/store/slices/automationViews";
import { mountEditor, query, typeText, type EditorHarness } from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import {
  automaticTriggers,
  automationRowTooltip,
  triggerState,
  triggerSummary,
} from "./automationRowInfo";

setupConnectionsRegion();
setupSettingsRegion();

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src-tauri/src/automations/testdata/newer.json"
);
const newer = (): Automation => JSON.parse(readFileSync(FIXTURE, "utf8")) as Automation;
/** What the IPC hop does to a value. */
const overIpc = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const unknownStep = { kind: "future-step", secret: "s3cret", continueOnError: true } as unknown;
const automation = (id: string, steps: unknown[]): Automation => ({
  id,
  name: id,
  tags: [],
  steps: steps as AutomationStep[],
  triggers: [],
  createdAt: "",
  updatedAt: "",
});

beforeEach(() => {
  saved.length = 0;
  library.splice(0, library.length, newer());
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState(automationLibraryState([newer()]));
});

describe("what the frontend writes keeps every unknown field", () => {
  let editor: EditorHarness | undefined;
  afterEach(() => {
    editor?.unmount();
    editor = undefined;
  });

  it("the editor: opens it and saves a rename, nothing else changed", async () => {
    editor = await mountEditor(newer());
    expect(query("automation-editor-step-kind-11")!.textContent).toContain("future-step");
    typeText("automation-editor-name", "Renamed");
    expect(overIpc(await editor.save())).toEqual({ ...newer(), name: "Renamed" });
  });

  it("the Armed switch", async () => {
    await useAppStore.getState().setWorkflowTriggersEnabled("newer", true);
    const { triggersEnabled: _off, ...armed } = newer();
    expect(overIpc(saved)).toEqual([armed]);
    await useAppStore.getState().setWorkflowTriggersEnabled("newer", false);
    expect(overIpc(saved[1])).toEqual(newer());
  });

  it("Duplicate copies them, under an id of its own and without the provenance", async () => {
    await useAppStore.getState().duplicateAutomation("newer");
    const { legacy: _legacy, ...rest } = newer();
    expect(overIpc(saved)).toEqual([
      {
        ...rest,
        id: expect.not.stringMatching(/^newer$/),
        name: "Copy of Newer",
        createdAt: "",
        updatedAt: "",
      },
    ]);
  });

  it("the workflow view", () => {
    const stored = newer();
    expect(overIpc(workflowToAutomation(automationToWorkflow(stored), stored))).toEqual(stored);
  });

  it("the workflow view still removes what it can edit", () => {
    const stored = newer();
    const { description: _d, ...view } = automationToWorkflow(stored);
    const next = workflowToAutomation(
      { ...view, parameters: [], triggersEnabled: undefined },
      stored
    );
    expect(overIpc(next)).toEqual(
      (({ description: _1, parameters: _2, triggersEnabled: _3, ...rest }) => rest)(stored)
    );
  });

  it("the macro view, also when it rewrites the keys", () => {
    const stored = {
      ...automation("m", [
        { kind: "type-keys", chunks: [{ data: "a", delayMs: 0 }], timing: "instant", fStep: 1 },
      ]),
      fAutomation: 1,
    };
    const view = automationToMacro(stored);
    expect(overIpc(macroToAutomation(view, stored))).toEqual(stored);
    const edited = macroToAutomation({ ...view, steps: [{ data: "b", delayMs: 1 }] }, stored);
    expect(edited).toMatchObject({ fAutomation: 1, steps: [{ fStep: 1, timing: "instant" }] });
  });
});

describe("kinds this build does not know", () => {
  const run = async (root: Automation, others: Automation[] = []) => {
    const send = vi.fn(() => true);
    const handle = runAutomation(root, {
      send,
      resolveAutomation: (id) => others.find((a) => a.id === id),
    });
    return { send, result: await handle.done };
  };
  const typed = { kind: "send-command", command: "uptime" };

  it.each<[string, unknown[], number]>([
    ["direct", [typed, unknownStep], 1],
    [
      "in a branch",
      [
        typed,
        {
          kind: "conditional",
          condition: { left: "a", op: "eq", right: "b" },
          then: [],
          else: [unknownStep],
        },
      ],
      1,
    ],
    [
      "in a loop",
      [{ kind: "loop", loop: { kind: "count", count: 1 }, body: [unknownStep] }, typed],
      0,
    ],
    ["through run-automation", [typed, { kind: "run-automation", automationId: "b" }], 1],
  ])("a step %s refuses the whole run before anything is typed", async (_name, steps, index) => {
    const { send, result } = await run(automation("a", steps), [automation("b", [unknownStep])]);
    expect(result).toMatchObject({
      status: "failed",
      stepsCompleted: 0,
      failedStepIndex: index,
    });
    expect(result.error).toContain("future-step");
    // The history keeps the error: it names the kind, never the step's content.
    expect(result.error).not.toContain("s3cret");
    expect(send).not.toHaveBeenCalled();
  });

  it("a kind named like something every object inherits is unknown too", async () => {
    const { send, result } = await run(automation("a", [typed, { kind: "constructor" }]));
    expect(result.status).toBe("failed");
    expect(send).not.toHaveBeenCalled();
  });

  it("known kinds run as before, also through a cycle-free call", async () => {
    const { send, result } = await run(
      automation("a", [typed, { kind: "run-automation", automationId: "b" }]),
      [automation("b", [typed])]
    );
    expect(result.status).toBe("completed");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("an unknown trigger never counts as automatic and does not break the row", () => {
    const bare = { ...newer(), triggersEnabled: undefined };
    const kinds = automaticTriggers(bare).map((t: AutomationTrigger) => t.kind);
    expect(kinds).toEqual(["on-connect", "on-disconnect", "on-output-match"]);
    const name = (id: string) => id;
    expect(triggerSummary(bare, name)).not.toContain("undefined");
    expect(
      triggerState(bare, { connectionName: name, resolve: () => undefined })?.text
    ).not.toContain("undefined");
    expect(automationRowTooltip(bare, name).join()).not.toContain("undefined");
  });
});
