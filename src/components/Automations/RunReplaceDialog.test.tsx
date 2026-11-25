import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { setWorkflowRunViewForTest } from "@/store/workflowRunBridge";
import { flushAsync } from "@/test/flushAsync";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { RunReplaceDialog } from "./RunReplaceDialog";

const automation = (id: string, name: string, step: AutomationStep): Automation => ({
  id,
  name,
  tags: [],
  steps: [step],
  triggers: [],
  createdAt: "",
  updatedAt: "",
});
const steps = automation("steps", "Deploy", { kind: "send-command", command: "make" });
const keys = automation("keys", "Login", { kind: "type-keys", chunks: [], timing: "recorded" });
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("a run never stops another one unasked (#6042)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const runWorkflow = vi.fn(() => Promise.resolve());
  const playMacro = vi.fn(() => Promise.resolve(null));

  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ ...automationLibraryState([steps, keys]), runWorkflow, playMacro });
    setWorkflowRunViewForTest({
      run: {
        runId: "r1",
        workflowId: "other",
        workflowName: "Health check",
        tabId: "t",
        label: "web-1",
        total: 3,
        completed: 1,
      },
      output: null,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<RunReplaceDialog />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setWorkflowRunViewForTest({ run: null, output: null });
  });

  const start = async (id: string) => {
    act(() => void useAppStore.getState().runAutomation(id));
    await flushAsync();
  };

  it("names the one it would stop, and starts nothing before the answer", async () => {
    await start("steps");
    expect(q("run-replace-dialog")?.textContent).toContain("Run “Deploy”?");
    expect(q("run-replace-dialog")?.textContent).toContain("“Health check” in web-1");
    expect(runWorkflow).not.toHaveBeenCalled();
    await act(async () => q("run-replace-confirm")!.click());
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when it is refused", async () => {
    await start("steps");
    await act(async () => q("run-replace-cancel")!.click());
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(q("run-replace-dialog")).toBeNull();
  });

  it("asks once, not again for a second start", async () => {
    await start("steps");
    await start("steps");
    await act(async () => q("run-replace-confirm")!.click());
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a run that stops nothing: the two kinds run side by side", async () => {
    await start("keys");
    expect(q("run-replace-dialog")).toBeNull();
    expect(playMacro).toHaveBeenCalledTimes(1);
    act(() =>
      useAppStore.setState({
        macroPlayback: { macroId: "m", macroName: "Login", tabId: "t", total: 2, played: 1 },
      })
    );
    await start("keys");
    expect(q("run-replace-dialog")).not.toBeNull();
  });
});
