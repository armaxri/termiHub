/**
 * Editor coverage for per-step error handling (PROD-045): the continue-on-error
 * and retry controls on every step (including nested sub-steps), validation
 * against the runner's caps gating Save, and saving a step with no policy
 * unchanged (no new keys).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowEditorDialog, type WorkflowEditorResult } from "./WorkflowEditorDialog";
import {
  stepPolicyErrors,
  workflowStepsPolicyValid,
  DEFAULT_STEP_RETRY,
} from "./workflowStepPolicySchema";
import { withTooltip } from "@/test/tooltip";
import { MAX_RETRY_DELAY_MS, MAX_STEP_RETRIES } from "@/services/workflowRunner";
import type { Workflow, WorkflowStep } from "@/types/workflow";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setInput(testId: string, value: string) {
  const input = query(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

const baseWorkflow: Workflow = {
  id: "workflow-1",
  name: "Deploy",
  tags: [],
  steps: [
    { kind: "send-command", command: "make deploy" },
    { kind: "wait", delayMs: 100 },
  ],
  triggers: [{ kind: "manual" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function render(workflow: Workflow = baseWorkflow) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  act(() => {
    root.render(
      withTooltip(
        <WorkflowEditorDialog
          open
          workflow={workflow}
          macros={[]}
          connections={[]}
          onOpenChange={vi.fn()}
          onSave={onSave}
        />
      )
    );
  });
  return { onSave };
}

async function save(onSave: ReturnType<typeof vi.fn>): Promise<WorkflowEditorResult> {
  act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
  await flush();
  return onSave.mock.calls[0][0] as WorkflowEditorResult;
}

describe("WorkflowEditorDialog — step error handling (PROD-045)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("saves a step without a policy unchanged (no new keys)", async () => {
    const { onSave } = render();
    const result = await save(onSave);
    expect(result.steps).toEqual(baseWorkflow.steps);
  });

  it("toggles continue-on-error on and off", async () => {
    const { onSave } = render();
    act(() => query("workflow-editor-step-continue-0")?.click());
    act(() => query("workflow-editor-step-continue-1")?.click());
    act(() => query("workflow-editor-step-continue-1")?.click());

    const result = await save(onSave);
    expect(result.steps[0]).toEqual({
      kind: "send-command",
      command: "make deploy",
      continueOnError: true,
    });
    expect(result.steps[1]).toEqual({ kind: "wait", delayMs: 100 });
  });

  it("enables retry with defaults and saves the edited count and delay", async () => {
    const { onSave } = render();
    expect(query("workflow-editor-step-retry-count-0")).toBeNull();

    act(() => query("workflow-editor-step-retry-0")?.click());
    expect((query("workflow-editor-step-retry-count-0") as HTMLInputElement).value).toBe(
      String(DEFAULT_STEP_RETRY.count)
    );
    setInput("workflow-editor-step-retry-count-0", "5");
    setInput("workflow-editor-step-retry-delay-0", "2500");

    const result = await save(onSave);
    expect(result.steps[0].retry).toEqual({ count: 5, delayMs: 2500, backoff: "fixed" });
  });

  it("removes the retry key when retry is switched off", async () => {
    const { onSave } = render({
      ...baseWorkflow,
      steps: [{ kind: "send-command", command: "x", retry: { count: 2 } }],
    });
    expect((query("workflow-editor-step-retry-count-0") as HTMLInputElement).value).toBe("2");

    act(() => query("workflow-editor-step-retry-0")?.click());
    const result = await save(onSave);
    expect(result.steps[0]).toEqual({ kind: "send-command", command: "x" });
  });

  it("blocks Save and shows an inline error for an out-of-range retry count", () => {
    render();
    act(() => query("workflow-editor-step-retry-0")?.click());
    setInput("workflow-editor-step-retry-count-0", String(MAX_STEP_RETRIES + 1));

    expect((query("workflow-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain(`from 1 to ${MAX_STEP_RETRIES}`);

    setInput("workflow-editor-step-retry-count-0", "2");
    expect((query("workflow-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks Save for an over-cap retry delay", () => {
    render();
    act(() => query("workflow-editor-step-retry-0")?.click());
    setInput("workflow-editor-step-retry-delay-0", String(MAX_RETRY_DELAY_MS + 1));
    expect((query("workflow-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the controls on nested conditional sub-steps", async () => {
    const { onSave } = render({
      ...baseWorkflow,
      steps: [
        {
          kind: "conditional",
          condition: { left: "a", op: "eq", right: "a" },
          then: [{ kind: "send-command", command: "inner" }],
        },
      ],
    });
    act(() => query("workflow-editor-step-continue-0-then-0")?.click());

    const result = await save(onSave);
    const cond = result.steps[0] as Extract<WorkflowStep, { kind: "conditional" }>;
    expect(cond.then[0]).toEqual({ kind: "send-command", command: "inner", continueOnError: true });
  });
});

describe("workflowStepPolicySchema", () => {
  const step = (extra: Partial<WorkflowStep>): WorkflowStep =>
    ({ kind: "send-command", command: "x", ...extra }) as WorkflowStep;

  it("accepts a step with no policy or a policy within bounds", () => {
    expect(stepPolicyErrors(step({}))).toEqual({});
    expect(
      stepPolicyErrors(
        step({
          continueOnError: true,
          retry: { count: MAX_STEP_RETRIES, delayMs: MAX_RETRY_DELAY_MS, backoff: "exponential" },
        })
      )
    ).toEqual({});
  });

  it.each([0, -1, 1.5, MAX_STEP_RETRIES + 1])("rejects retry count %s", (count) => {
    expect(stepPolicyErrors(step({ retry: { count } })).count).toMatch(/whole number/);
  });

  it("rejects a negative or over-cap delay", () => {
    expect(stepPolicyErrors(step({ retry: { count: 1, delayMs: -1 } })).delayMs).toBeDefined();
    expect(
      stepPolicyErrors(step({ retry: { count: 1, delayMs: MAX_RETRY_DELAY_MS + 1 } })).delayMs
    ).toBeDefined();
  });

  it("validates nested steps recursively", () => {
    const bad: WorkflowStep = {
      kind: "loop",
      loop: { kind: "count", count: 2 },
      body: [step({ retry: { count: 0 } })],
    };
    expect(workflowStepsPolicyValid([bad])).toBe(false);
    expect(workflowStepsPolicyValid([{ ...bad, body: [step({ retry: { count: 1 } })] }])).toBe(
      true
    );
  });
});
