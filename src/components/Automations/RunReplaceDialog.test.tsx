import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { setWorkflowRunViewForTest } from "@/store/workflowRunBridge";
import { flushAsync } from "@/test/flushAsync";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import { seedLayoutState } from "@/test/layoutState";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
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

  /** Make tab `id` the active one, next to another. */
  const seedActive = (id: string) => {
    const tab = (tabId: string) =>
      ({ id: tabId, title: tabId, contentType: "terminal", panelId: "leaf" }) as TerminalTab;
    const leaf: LeafPanel = {
      type: "leaf",
      id: "leaf",
      tabs: [tab("t"), tab("u")],
      activeTabId: id,
    };
    seedLayoutState({ rootPanel: leaf, activePanelId: "leaf" });
  };

  const start = async (id: string) => {
    act(() => void useAppStore.getState().runAutomation(id));
    await flushAsync();
  };

  it("names the one it would stop, and starts nothing before the answer", async () => {
    const cancelWorkflowRun = vi.fn();
    useAppStore.setState({ cancelWorkflowRun });
    act(() => seedActive("t"));
    await start("steps");
    expect(q("run-replace-dialog")?.textContent).toContain("Run “Deploy”?");
    expect(q("run-replace-dialog")?.textContent).toContain(
      "“Health check” is running in web-1, at step 2 of 3. Running this stops that there"
    );
    expect(runWorkflow).not.toHaveBeenCalled();
    await act(async () => q("run-replace-confirm")!.click());
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    // Its own kind is stopped by the start, once nothing can stop that any more.
    expect(cancelWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not ask for a step-by-step run on another terminal: they run side by side", async () => {
    act(() => seedActive("u"));
    await start("steps");
    expect(q("run-replace-dialog")).toBeNull();
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when it is refused", async () => {
    act(() => seedActive("t"));
    await start("steps");
    await act(async () => q("run-replace-cancel")!.click());
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(q("run-replace-dialog")).toBeNull();
  });

  it("asks once, not again for a second start", async () => {
    act(() => seedActive("t"));
    await start("steps");
    const asked = useAppStore.getState().runReplacePrompt;
    await start("steps");
    expect(useAppStore.getState().runReplacePrompt).toBe(asked);
    await act(async () => q("run-replace-confirm")!.click());
    expect(runWorkflow).toHaveBeenCalledTimes(1);
  });

  it("does not ask for a run of the other kind on another terminal", async () => {
    await start("keys");
    expect(q("run-replace-dialog")).toBeNull();
    expect(playMacro).toHaveBeenCalledTimes(1);
    act(() =>
      useAppStore.setState({
        macroPlayback: { macroId: "m", macroName: "Login", tabId: "u", total: 2, played: 1 },
      })
    );
    await start("keys");
    expect(q("run-replace-dialog")).not.toBeNull();
  });

  it("never lets the two kinds type into one terminal: it asks, and stops the other (#6042)", async () => {
    const cancelWorkflowRun = vi.fn();
    useAppStore.setState({ cancelWorkflowRun });
    act(() => seedActive("t"));
    await start("keys");
    expect(q("run-replace-dialog")?.textContent).toContain("“Health check” is running in web-1");
    expect(playMacro).not.toHaveBeenCalled();
    await act(async () => q("run-replace-confirm")!.click());
    // Its History says what stopped it.
    expect(cancelWorkflowRun).toHaveBeenCalledWith("r1", "“Login” was started in this terminal");
    expect(playMacro).toHaveBeenCalledTimes(1);
  });

  it("asks before a step-by-step run types where keys are typed, and stops them there", async () => {
    setWorkflowRunViewForTest({ run: null, output: null });
    const cancelMacroPlaybackOnTab = vi.fn();
    useAppStore.setState({
      cancelMacroPlaybackOnTab,
      macroPlayback: {
        macroId: "keys",
        macroName: "Login",
        tabId: "t",
        targetTabIds: ["t", "u"],
        total: 2,
        played: 1,
      },
    });
    await start("steps");
    expect(q("run-replace-dialog")).toBeNull();
    act(() => seedActive("t"));
    await start("steps");
    expect(q("run-replace-dialog")?.textContent).toContain("“Login” is running");
    await act(async () => q("run-replace-confirm")!.click());
    expect(cancelMacroPlaybackOnTab.mock.calls).toEqual([
      ["t", "“Deploy” was started in this terminal"],
    ]);
    expect(runWorkflow).toHaveBeenCalledTimes(2);
  });

  it("asks about the terminals that were picked", async () => {
    await act(
      async () => void useAppStore.getState().runAutomation("keys", { targetTabIds: ["u"] })
    );
    expect(q("run-replace-dialog")).toBeNull();
    await act(
      async () => void useAppStore.getState().runAutomation("keys", { targetTabIds: ["u", "t"] })
    );
    expect(q("run-replace-dialog")).not.toBeNull();
  });
});
