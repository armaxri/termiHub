/**
 * The Automations sidebar (#5818, slice 6): one list for what were macros and
 * workflows, with every action the two old sidebars had.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import { installResizeObserverMock, type ResizeObserverMock } from "@/test/resizeObserver";
import { openAutomationRowMenu, openMenu } from "@/test/automationRowMenu";
import { seedLayoutState } from "@/test/layoutState";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationRun } from "@/types/generated/AutomationRun";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

const dialogSave = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => dialogSave(...args),
}));
const fsWriteTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => fsWriteTextFile(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (...args: unknown[]) => toastSuccess(...args),
      info: (...args: unknown[]) => toastInfo(...args),
      error: (...args: unknown[]) => toastError(...args),
    },
  };
});

import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import { setWorkflowRunViewForTest } from "@/store/workflowRunBridge";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { parseAutomationFile } from "@/services/automationFileIo";
import { resetRememberedRunTargetChoice } from "@/components/Automations/runTargetChoice";
import { AUTOMATION_JUST_SAVED_MS } from "./AutomationRow";
import { AutomationEditorHost, useAutomationEditor } from "@/components/AutomationEditor";
import { AutomationSidebar } from "./AutomationSidebar";
import { useAutomationSections } from "./automationSections";

setupConnectionsRegion();

/** The sidebar and the app-level editor it opens. */
const SidebarAndEditor = () => (
  <>
    <AutomationSidebar />
    <AutomationEditorHost />
  </>
);

let container: HTMLDivElement;
let root: Root;
let ro: ResizeObserverMock;

const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const click = (testId: string) =>
  act(() => {
    const el = query(testId);
    if (!el) throw new Error(`no ${testId}`);
    el.click();
  });

function key(el: Element, keyName: string, mods: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, ...mods }));
  });
}

/** Choose an entry of an automation's "…" menu. */
function choose(automationId: string, entry: string): void {
  openAutomationRowMenu(automationId);
  click(`automation-menu-${entry}-${automationId}`);
}

function setSearch(value: string): void {
  const input = query("automation-search") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const base = { tags: [] as string[], triggers: [], createdAt: "", updatedAt: "" };
const typed: Automation = {
  ...base,
  id: "macro-1",
  name: "Sudo login",
  description: "Type the login",
  tags: ["ops"],
  steps: [
    {
      kind: "type-keys",
      chunks: [{ data: "sudo -v\r", delayMs: 0 }],
      timing: "recorded",
      recorded: true,
    },
  ],
};
const steps: Automation = {
  ...base,
  id: "workflow-1",
  name: "Deploy prep",
  tags: ["release"],
  steps: [{ kind: "send-command", command: "make build" }],
};
const triggered: Automation = {
  ...base,
  id: "workflow-2",
  name: "Answer on match",
  steps: [{ kind: "wait", delayMs: 100 }],
  triggers: [{ kind: "on-output-match", connectionIds: ["conn-1"], pattern: "yes/no" }],
};
const library = [typed, steps, triggered];

function setLibrary(automations: Automation[]): void {
  useAppStore.setState(automationLibraryState(automations));
}

const storeFns = {
  runAutomation: vi.fn(),
  playMacro: vi.fn(),
  runWorkflow: vi.fn(),
  duplicateAutomation: vi.fn(),
  deleteAutomationFromBackend: vi.fn(),
  saveAutomationToBackend: vi.fn(),
  setWorkflowTriggersEnabled: vi.fn(),
  openSettingsTab: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  cancelMacroPlayback: vi.fn(),
  cancelMacroPlaybackOnTab: vi.fn(),
  openScheduleEditor: vi.fn(),
  toggleRecording: vi.fn(),
  loadAutomationRuns: vi.fn(),
};

function seedTerminals(active: string | null = "tab-a"): void {
  const tab = (id: string, title: string): TerminalTab => ({
    id,
    sessionId: `sess-${id}`,
    title,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: id === active,
  });
  const leaf: LeafPanel = {
    type: "leaf",
    id: "leaf-1",
    tabs: active ? [tab("tab-a", "web-1"), tab("tab-b", "web-2")] : [],
    activeTabId: active,
  };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

function failedRun(automationId: string): AutomationRun {
  return {
    id: "r-failed",
    automationId,
    automationName: "x",
    startedAt: "2026-11-24T10:00:00Z",
    endedAt: "2026-11-24T10:00:01Z",
    status: "failed",
    stepsCompleted: 0,
    total: 1,
    origin: "scheduled",
    error: "timed out",
  };
}

beforeEach(() => {
  ro = installResizeObserverMock();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
  resetRememberedRunTargetChoice();
  for (const fn of Object.values(storeFns)) fn.mockResolvedValue(undefined);
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({ ...storeFns });
  useAutomationSections.setState(useAutomationSections.getInitialState());
  useAutomationEditor.setState({ editing: null });
  seedConnectionsRegion({
    connections: [
      { id: "conn-1", name: "prod", config: { type: "ssh", config: {} }, folderId: null },
    ],
  });
  setWorkflowRunViewForTest({ run: null, output: null });
  seedTerminals();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  ro.restore();
});

async function render(automations: Automation[] = library): Promise<void> {
  setLibrary(automations);
  await act(async () => root.render(withTooltip(<SidebarAndEditor />)));
  await flushAsync();
}

const rowIds = () =>
  Array.from(document.querySelectorAll('[role="treeitem"]')).map((el) =>
    el.getAttribute("data-testid")
  );

describe("one list", () => {
  it("lists typed, step-by-step and triggered automations together, in store order", async () => {
    await render();
    expect(rowIds()).toEqual([
      "automation-item-macro-1",
      "automation-item-workflow-1",
      "automation-item-workflow-2",
    ]);
    // One kind of thing: no row, tooltip or control says macro or workflow.
    expect(query("automation-sidebar")!.textContent).not.toMatch(/macro|workflow/i);
    for (const row of document.querySelectorAll('[role="treeitem"]')) {
      expect(row.getAttribute("aria-description") ?? "").not.toMatch(/macro|workflow/i);
    }
  });

  it("shows the name, the description and markers on a row, never settings", async () => {
    await render();
    expect(query("automation-item-macro-1")!.textContent).toBe("Sudo loginType the login");
    expect(query("automation-item-workflow-1")!.textContent).toBe("Deploy prep");
    expect(query("automation-item-workflow-2")!.textContent).toBe(
      "Answer on matchTriggers on: matching output in prod"
    );
    expect(query("automation-item-workflow-2")!.getAttribute("aria-description")).toContain(
      "On output match · prod"
    );
  });

  it.each([
    ["name", "deploy", ["automation-item-workflow-1"]],
    ["description", "the login", ["automation-item-macro-1"]],
    ["tag", "release", ["automation-item-workflow-1"]],
  ])("searches by %s", async (_field, text, expected) => {
    await render();
    setSearch(text);
    expect(rowIds()).toEqual(expected);
  });

  it("offers to clear a search that finds nothing", async () => {
    await render();
    setSearch("zzz");
    expect(query("automation-no-results")!.textContent).toContain("No automations match “zzz”.");
    click("automation-clear-search-btn");
    expect(rowIds()).toHaveLength(3);
  });
});

describe("empty state", () => {
  it("says what automations are and offers the two ways to make one", async () => {
    await render([]);
    expect(query("automation-empty")!.textContent).toContain("No automations yet.");
    click("automation-empty-record-btn");
    expect(storeFns.toggleRecording).toHaveBeenCalledTimes(1);
    click("automation-empty-new-btn");
    expect(query("automation-editor-dialog")).not.toBeNull();
  });

  it("without a terminal offers to open one and record there (A-004)", async () => {
    const recordInNewTerminal = vi.fn(async () => true);
    seedLayoutState({
      rootPanel: { type: "leaf", id: "leaf", tabs: [], activeTabId: null },
      activePanelId: "leaf",
    });
    await render([]);
    act(() => useAppStore.setState({ recordInNewTerminal }));
    expect(query("automation-empty-record-btn")!.textContent).toBe("Open a terminal and record");
    click("automation-empty-record-btn");
    expect(recordInNewTerminal).toHaveBeenCalledTimes(1);
    expect(storeFns.toggleRecording).not.toHaveBeenCalled();
  });

  it("keeps the way to import reachable", async () => {
    await render([]);
    openMenu("automation-new-btn");
    expect(query("automation-files-btn")!.hasAttribute("data-disabled")).toBe(false);
  });
});

describe("toolbar (R-037)", () => {
  it("names every action in text", async () => {
    await render();
    expect(query("automation-new-btn")!.textContent).toBe("New");
    expect(query("automation-record-btn")!.textContent).toBe("Record");
    openMenu("automation-new-btn");
    expect(query("automation-files-btn")!.textContent).toBe("Import or export…");
  });

  it("creates step by step or from typed keystrokes, in the one editor", async () => {
    await render();
    openMenu("automation-new-btn");
    click("automation-new-steps");
    expect(query("automation-editor-no-steps")).not.toBeNull();
    click("automation-editor-cancel");
    expect(query("automation-editor-dialog")).toBeNull();
    openMenu("automation-new-btn");
    click("automation-new-keys");
    expect(query("automation-editor-keys-text-0-0")).not.toBeNull();
  });

  it("records, and says so while it does", async () => {
    await render();
    click("automation-record-btn");
    expect(storeFns.toggleRecording).toHaveBeenCalledTimes(1);
    act(() =>
      useAppStore.setState({
        recording: {
          tabId: "tab-a",
          tabTitle: "web-1",
          keys: 0,
          atPrompt: false,
          intoEditor: null,
        },
      })
    );
    expect(query("automation-record-btn")!.textContent).toBe("Stop recording");
  });

  it("leaves the stop of a recording for the editor to the bar (A-010)", async () => {
    await render();
    act(() =>
      useAppStore.setState({
        recording: {
          tabId: "tab-a",
          tabTitle: "web-1",
          keys: 0,
          atPrompt: false,
          intoEditor: "Deploy",
        },
      })
    );
    expect(query("automation-record-btn")).toBeNull();
  });

  it("folds Record into one menu only below the smallest sidebar", async () => {
    await render();
    ro.resize(184); // the 200px minimum sidebar's toolbar
    expect(query("automation-new-btn")!.textContent).toBe("New");
    expect(query("automation-record-btn")!.textContent).toBe("Record");
    ro.resize(110);
    expect(query("automation-new-btn")).not.toBeNull();
    openMenu("automation-toolbar-overflow");
    expect(query("automation-record-btn")!.getAttribute("role")).toBe("menuitem");
  });
});

describe("running", () => {
  it("runs on the active terminal and says which one", async () => {
    await render();
    for (const id of ["macro-1", "workflow-1"]) {
      click(`automation-start-${id}`);
      expect(storeFns.runAutomation).toHaveBeenLastCalledWith(id);
    }
    expect(query("automation-start-workflow-1")!.getAttribute("aria-label")).toBe(
      "Run Deploy prep"
    );
  });

  it("asks where instead of failing when no terminal is active", async () => {
    seedTerminals(null);
    await render();
    click("automation-start-macro-1");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(query("run-targets-dialog")!.textContent).toContain("Run “Sudo login”");
    expect(query("automation-start-macro-1")!.getAttribute("aria-label")).toBe(
      "Run Sudo login on…"
    );
  });

  it.each(["macro-1", "workflow-1"])("runs %s on picked terminals", async (id) => {
    await render();
    choose(id, "run-on");
    click("run-targets-target-pick");
    click("run-targets-terminal-tab-b");
    click("run-targets-run");
    expect(storeFns.runAutomation).not.toHaveBeenCalled(); // asks to confirm
    click("run-targets-run");
    expect(storeFns.runAutomation).toHaveBeenCalledWith(id, {
      targetTabIds: ["tab-a", "tab-b"],
      parallel: true,
    });
  });

  it("edits on a row double-click and never runs, and leaves its buttons alone (A-015)", async () => {
    await render();
    const dbl = (testId: string) =>
      act(() => {
        query(testId)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
    dbl("automation-start-macro-1");
    dbl("automation-arm-toggle-workflow-2");
    expect(query("automation-editor-dialog")).toBeNull();
    dbl("automation-name-macro-1");
    expect(query("automation-editor-dialog")).not.toBeNull();
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
  });

  it("shows Running and Stop for a step run, and stops every queued terminal with it", async () => {
    setWorkflowRunViewForTest({
      run: {
        runId: "r1",
        workflowId: "workflow-1",
        workflowName: "Deploy prep",
        tabId: "tab-a",
        total: 1,
        completed: 0,
      },
      output: null,
    });
    await render();
    expect(query("automation-running-workflow-1")!.textContent).toBe("Running");
    expect(query("automation-start-workflow-1")).toBeNull();
    // One terminal has its line too: where, and which step (A-017).
    expect(query("automation-target-r1")!.textContent).toContain("in web-1, step 1 of 1");
    click("automation-stop-workflow-1");
    expect(storeFns.cancelWorkflowRun).toHaveBeenCalledWith();
    // The keyboard never starts it a second time.
    key(query("automation-item-workflow-1")!, "ArrowDown");
    key(query("automation-item-workflow-1")!, "Enter", { ctrlKey: true });
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
  });

  it("lists each terminal of a fan-out with its own stop (#3418)", async () => {
    const target = (runId: string, label: string, completed: number) => ({
      runId,
      workflowId: "workflow-1",
      workflowName: "Deploy prep",
      tabId: `tab-${runId}`,
      label,
      total: 3,
      completed,
    });
    setWorkflowRunViewForTest({
      run: target("r2", "db-2", 2),
      runs: [target("r1", "web-1", 1), target("r2", "db-2", 2)],
      output: null,
    });
    await render();
    expect(query("automation-running-workflow-1")!.getAttribute("aria-label")).toBe("Running 2");
    // It ends both, so it says so; each line has its own (B-003).
    expect(query("automation-stop-workflow-1")!.textContent).toBe("Stop all 2");
    expect(query("automation-target-r1")!.textContent).toContain("in web-1, step 2 of 3");
    expect(query("automation-target-r2")!.textContent).toContain("in db-2, step 3 of 3");
    click("automation-target-stop-r2");
    expect(storeFns.cancelWorkflowRun).toHaveBeenLastCalledWith("r2");
    click("automation-stop-workflow-1");
    expect(storeFns.cancelWorkflowRun).toHaveBeenLastCalledWith();
  });

  it("shows a keystroke playback the same way, one terminal or several", async () => {
    await render();
    const playback = {
      macroId: "macro-1",
      macroName: "Sudo login",
      tabId: "tab-a",
      total: 4,
      played: 2,
    };
    act(() => useAppStore.setState({ macroPlayback: playback }));
    expect(query("automation-running-macro-1")!.textContent).toBe("Running");
    click("automation-stop-macro-1");
    expect(storeFns.cancelMacroPlayback).toHaveBeenCalledTimes(1);
    expect(storeFns.cancelWorkflowRun).not.toHaveBeenCalled();

    act(() =>
      useAppStore.setState({
        macroPlayback: {
          ...playback,
          targetTabIds: ["tab-a", "tab-b"],
          targetProgress: { "tab-a": 3, "tab-b": 1 },
        },
      })
    );
    expect(query("automation-target-tab-a")!.textContent).toContain("in web-1, 75 % typed");
    expect(query("automation-target-tab-b")!.textContent).toContain("in web-2, 25 % typed");
    click("automation-target-stop-tab-b");
    expect(storeFns.cancelMacroPlaybackOnTab).toHaveBeenCalledWith("tab-b");
  });
});

describe("markers", () => {
  it("switches triggers without running or opening anything (R-077)", async () => {
    await render();
    const line = query("automation-armed-workflow-2")!;
    expect(line.textContent).toBe("Triggers on: matching output in prod");
    const toggle = query("automation-arm-toggle-workflow-2")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    click("automation-arm-toggle-workflow-2");
    expect(storeFns.setWorkflowTriggersEnabled).toHaveBeenCalledWith("workflow-2", false);
    key(query("automation-arm-toggle-workflow-2")!, "Enter");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(query("automation-editor-dialog")).toBeNull();
  });

  it("says what no longer happens while they are off, and still offers Run (A-013)", async () => {
    await render([{ ...triggered, triggersEnabled: false }]);
    expect(query("automation-armed-workflow-2")!.textContent).toBe(
      "Triggers off: matching output in prod does not start it. You can still run it."
    );
    expect(query("automation-start-workflow-2")).not.toBeNull();
    click("automation-arm-toggle-workflow-2");
    expect(storeFns.setWorkflowTriggersEnabled).toHaveBeenCalledWith("workflow-2", true);
  });

  it("keeps the switch of an automation with only a hotkey, on and off (A-014)", async () => {
    const hotkey: Automation = {
      ...triggered,
      triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+D" }],
      triggersEnabled: false,
    };
    await render([hotkey]);
    const toggle = query("automation-arm-toggle-workflow-2")!;
    expect(query("automation-armed-workflow-2")!.textContent).toContain("hotkey Ctrl+Alt+D");
    act(() => toggle.focus());
    click("automation-arm-toggle-workflow-2");
    expect(storeFns.setWorkflowTriggersEnabled).toHaveBeenCalledWith("workflow-2", true);
    act(() => setLibrary([{ ...hotkey, triggersEnabled: undefined }]));
    expect(query("automation-armed-workflow-2")!.textContent).toBe(
      "Triggers on: hotkey Ctrl+Alt+D"
    );
    expect(document.activeElement).toBe(query("automation-arm-toggle-workflow-2"));
  });

  it("says which step cannot run instead of offering Run (A-016)", async () => {
    await render([
      {
        ...steps,
        steps: [{ kind: "run-local-process", program: "make", args: [] }],
      },
    ]);
    expect(query("automation-start-workflow-1")).toBeNull();
    expect(query("automation-blocked-reason-workflow-1")!.textContent).toMatch(
      /Allow experimental features/
    );
    const item = query("automation-item-workflow-1")!;
    key(item, "Enter", { ctrlKey: true });
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(item.getAttribute("aria-label")).toContain("Cannot run");
  });

  it("a run that waits for the user says so, and is not Running (#6026)", async () => {
    setWorkflowRunViewForTest({
      run: {
        runId: "r1",
        workflowId: "workflow-1",
        workflowName: "Deploy prep",
        tabId: "tab-a",
        total: 2,
        completed: 1,
      },
      output: null,
    });
    useAppStore.setState({ automationWaits: [{ runId: "r1" }] as never });
    await render();
    // In words on the line under the name, which keeps its room (C-008).
    expect(query("automation-running-workflow-1")!.getAttribute("aria-label")).toBe(
      "Waiting for you"
    );
    expect(query("automation-target-r1")!.textContent).toContain("step 2 of 2 waits for you");
  });

  it("reports a failed disarm", async () => {
    storeFns.setWorkflowTriggersEnabled.mockRejectedValue(new Error("disk full"));
    await render();
    click("automation-arm-toggle-workflow-2");
    await flushAsync();
    expect(toastError).toHaveBeenCalledWith(
      "The triggers of “Answer on match” could not be changed",
      {
        description: "disk full",
      }
    );
  });

  it("has no switch without an automatic trigger", async () => {
    await render();
    expect(query("automation-arm-toggle-workflow-1")).toBeNull();
    expect(query("automation-armed-macro-1")).toBeNull();
  });

  it("marks a failed automatic run and opens its history from the marker", async () => {
    await render();
    act(() => useAppStore.setState({ automationRuns: [failedRun("workflow-1")] }));
    expect(query("automation-failed-workflow-1")!.textContent).toBe("Failed");
    expect(query("automation-failed-macro-1")).toBeNull();
    click("automation-failed-workflow-1");
    expect(query("automation-history-list")).not.toBeNull();
    expect(useAutomationSections.getState().historyAutomationId).toBe("workflow-1");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
  });

  it("drops marker words, not markers, in a narrow sidebar", async () => {
    await render();
    act(() => useAppStore.setState({ automationRuns: [failedRun("workflow-2")] }));
    ro.resize(200);
    expect(query("automation-failed-workflow-2")!.textContent).toBe("");
    expect(query("automation-failed-workflow-2")!.getAttribute("aria-label")).toContain(
      "Last run failed"
    );
    // Run and the switch stay.
    expect(query("automation-start-workflow-2")).not.toBeNull();
    expect(query("automation-arm-toggle-workflow-2")).not.toBeNull();
    ro.resize(320);
    expect(query("automation-failed-workflow-2")!.textContent).toBe("Failed");
  });
});

describe("row actions", () => {
  it("keeps Edit in place when the press selects the row, or no click would follow", async () => {
    await render();
    const edit = query("automation-edit-workflow-1")!;
    act(() => query("automation-item-workflow-1")!.focus());
    expect(query("automation-item-workflow-1")!.tabIndex).toBe(0);
    expect(query("automation-edit-workflow-1")).toBe(edit);
    expect(query("automation-primary-workflow-1")!.contains(edit)).toBe(true);
  });

  it.each(["macro-1", "workflow-1"])(
    "opens the editor on %s, from the button and the menu",
    async (id) => {
      await render();
      click(`automation-edit-${id}`);
      expect(query("automation-editor-dialog")).not.toBeNull();
      click("automation-editor-cancel");
      expect(query("automation-editor-dialog")).toBeNull();
      choose(id, "edit");
      expect(query("automation-editor-dialog")).not.toBeNull();
    }
  );

  it("schedules, shows recent runs, duplicates and runs from the menu", async () => {
    await render();
    choose("macro-1", "schedule");
    expect(storeFns.openScheduleEditor).toHaveBeenCalledWith({
      action: { kind: "automation", automationId: "macro-1" },
    });
    choose("macro-1", "history");
    expect(useAutomationSections.getState()).toMatchObject({
      historyOpen: true,
      historyAutomationId: "macro-1",
    });
    choose("workflow-1", "duplicate");
    expect(storeFns.duplicateAutomation).toHaveBeenCalledWith("workflow-1");
    choose("workflow-1", "run");
    expect(storeFns.runAutomation).toHaveBeenCalledWith("workflow-1");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("reports a failed duplicate", async () => {
    storeFns.duplicateAutomation.mockRejectedValue(new Error("disk full"));
    await render();
    choose("macro-1", "duplicate");
    await flushAsync();
    expect(toastError).toHaveBeenCalledWith("Failed to duplicate “Sudo login”", {
      description: "disk full",
    });
  });

  it("starts a new automation from typed keystrokes (was: promote a macro)", async () => {
    await render();
    choose("macro-1", "use-in-new");
    expect((query("automation-editor-name") as HTMLInputElement).value).toBe("Sudo login");
    expect(query("automation-editor-step-automation-0")!.textContent).toContain("Sudo login");
    click("automation-editor-cancel");
    openAutomationRowMenu("workflow-1");
    expect(query("automation-menu-use-in-new-workflow-1")).toBeNull();
  });

  it("deletes only after a confirmation", async () => {
    await render();
    choose("workflow-1", "delete");
    expect(storeFns.deleteAutomationFromBackend).not.toHaveBeenCalled();
    expect(query("confirm-delete-dialog")!.textContent).toContain(
      "Delete automation “Deploy prep”? This cannot be undone."
    );
    expect(query("confirm-delete-dialog")!.textContent).not.toContain("It is used by");
    click("confirm-delete-confirm");
    await flushAsync();
    expect(storeFns.deleteAutomationFromBackend).toHaveBeenCalledWith("workflow-1");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("reports a failed delete", async () => {
    storeFns.deleteAutomationFromBackend.mockRejectedValue(new Error("disk full"));
    await render();
    choose("macro-1", "delete");
    click("confirm-delete-confirm");
    await flushAsync();
    expect(toastError).toHaveBeenCalledWith("Failed to delete automation: disk full");
  });

  it("opens the same menu on right-click", async () => {
    await render();
    act(() => {
      query("automation-item-macro-1")!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      );
    });
    const entries = Array.from(document.querySelectorAll('[role="menuitem"]')).map(
      (el) => el.textContent
    );
    expect(entries).toEqual([
      "Run",
      "Run on…",
      "Schedule…",
      "Recent runs",
      "Edit…",
      "Duplicate",
      "New automation from this…",
      "Export…",
      "Delete…",
    ]);
  });
});

describe("the editor", () => {
  const set = (testId: string, value: string) => {
    const input = query(testId) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("stores an edit and keeps the dialog when that fails", async () => {
    storeFns.saveAutomationToBackend.mockRejectedValueOnce(new Error("disk full"));
    await render();
    click("automation-edit-macro-1");
    set("automation-editor-name", "Sudo prompt");
    click("automation-editor-save");
    await flushAsync();
    expect(toastError).toHaveBeenCalledWith("Failed to save automation: disk full");
    expect(query("automation-editor-dialog")).not.toBeNull();
    click("automation-editor-save");
    await flushAsync();
    expect(query("automation-editor-dialog")).toBeNull();
    expect(storeFns.saveAutomationToBackend).toHaveBeenLastCalledWith({
      ...typed,
      name: "Sudo prompt",
    });
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
  });

  it("stores nothing when nothing changed", async () => {
    await render();
    click("automation-edit-macro-1");
    click("automation-editor-save");
    await flushAsync();
    expect(query("automation-editor-dialog")).toBeNull();
    expect(storeFns.saveAutomationToBackend).not.toHaveBeenCalled();
    expect(query("automation-item-macro-1")!.hasAttribute("data-just-saved")).toBe(false);
  });

  it("creates typed keys under a fresh id, and Save and run runs them", async () => {
    await render();
    openMenu("automation-new-btn");
    click("automation-new-keys");
    set("automation-editor-name", "Greet");
    set("automation-editor-keys-text-0-0", "echo hi\\r");
    click("automation-editor-save-run");
    await flushAsync();
    const saved = storeFns.saveAutomationToBackend.mock.calls[0][0] as Automation;
    expect(saved).toMatchObject({
      name: "Greet",
      steps: [
        { kind: "type-keys", chunks: [{ data: "echo hi\r", delayMs: 0 }], timing: "recorded" },
      ],
    });
    expect(saved.id).toMatch(/^automation-/);
    expect(storeFns.runAutomation).toHaveBeenCalledWith(saved.id);
  });

  it("Save and run asks where without an active terminal", async () => {
    await render();
    seedTerminals(null);
    await flushAsync();
    click("automation-edit-workflow-1");
    click("automation-editor-save-run");
    await flushAsync();
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(query("run-targets-dialog")).not.toBeNull();
  });

  it("opens the schedule editor for a new automation once it is saved", async () => {
    await render();
    openMenu("automation-new-btn");
    click("automation-new-keys");
    set("automation-editor-name", "Greet");
    set("automation-editor-keys-text-0-0", "x");
    click("automation-editor-when-toggle");
    openMenu("automation-editor-add-trigger");
    click("automation-editor-add-schedule");
    await flushAsync();
    expect(storeFns.openScheduleEditor).not.toHaveBeenCalled();
    click("automation-editor-save");
    await flushAsync();
    const { id } = storeFns.saveAutomationToBackend.mock.calls[0][0] as Automation;
    expect(storeFns.openScheduleEditor).toHaveBeenCalledWith({
      action: { kind: "automation", automationId: id },
    });
  });

  describe("mark the saved row (#5687)", () => {
    afterEach(() => {
      vi.useRealTimers();
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    it.each(["macro-1", "workflow-2"])(
      "highlights %s, scrolls it into view, then unmarks it",
      async (id) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const scrolled: Array<{ testId: string | null; opts: unknown }> = [];
        HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, opts?: unknown) {
          scrolled.push({ testId: this.getAttribute("data-testid"), opts });
        } as HTMLElement["scrollIntoView"];
        await act(async () => {
          setLibrary(library);
          root.render(withTooltip(<SidebarAndEditor />));
        });
        click(`automation-edit-${id}`);
        set("automation-editor-name", "Renamed");
        scrolled.length = 0;
        click("automation-editor-save");
        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });
        const row = query(`automation-item-${id}`)!;
        expect(row.getAttribute("data-just-saved")).toBe("true");
        expect(row.classList.contains("automation-item--just-saved")).toBe(true);
        expect(scrolled.filter((s) => s.testId === `automation-item-${id}`)).toEqual([
          { testId: `automation-item-${id}`, opts: { block: "nearest", behavior: "smooth" } },
        ]);
        expect(query("automation-item-workflow-1")!.hasAttribute("data-just-saved")).toBe(false);
        act(() => {
          vi.advanceTimersByTime(AUTOMATION_JUST_SAVED_MS);
        });
        expect(query(`automation-item-${id}`)!.hasAttribute("data-just-saved")).toBe(false);
        expect(toastSuccess).not.toHaveBeenCalled();
      }
    );
  });
});

describe("files (#5818, slice 11)", () => {
  it("links to the settings, where import and export live", async () => {
    await render();
    openMenu("automation-new-btn");
    click("automation-files-btn");
    expect(storeFns.openSettingsTab).toHaveBeenCalledWith({ category: "import" });
  });

  it.each([
    ["macro-1", "termihub-automation-sudo-login.json", "Sudo login"],
    ["workflow-1", "termihub-automation-deploy-prep.json", "Deploy prep"],
  ])("exports %s on its own", async (id, path, name) => {
    dialogSave.mockResolvedValue("/tmp/a.json");
    await render();
    choose(id, "export");
    await flushAsync();
    expect(dialogSave.mock.calls[0][0].defaultPath).toBe(path);
    const file = parseAutomationFile(fsWriteTextFile.mock.calls[0][1] as string);
    expect(file.entries.automations.map((e) => e.automation.name)).toEqual([name]);
    expect(toastSuccess).toHaveBeenCalledWith(`Exported “${name}”`);
  });

  it("exports the automations one runs with it, and says so", async () => {
    dialogSave.mockResolvedValue("/tmp/a.json");
    const caller: Automation = {
      ...library[1],
      id: "caller",
      name: "Caller",
      steps: [{ kind: "run-automation", automationId: "macro-1" }],
    };
    await render([...library, caller]);
    choose("caller", "export");
    await flushAsync();
    const file = parseAutomationFile(fsWriteTextFile.mock.calls[0][1] as string);
    expect(file.entries.automations.map((e) => e.automation.name)).toEqual([
      "Caller",
      "Sudo login",
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Exported “Caller” and the automation it runs");
  });

  it("does nothing when the dialog is canceled", async () => {
    dialogSave.mockResolvedValue(null);
    await render();
    choose("macro-1", "export");
    await flushAsync();
    expect(fsWriteTextFile).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("sections", () => {
  it("starts with Schedules and History closed, and opens them from their headers", async () => {
    await render();
    for (const [toggle, content] of [
      ["schedules-section-toggle", "schedules-empty"],
      ["automation-history-toggle", "automation-history-empty"],
    ]) {
      expect(query(toggle)!.getAttribute("aria-expanded")).toBe("false");
      expect(query(content)).toBeNull();
      click(toggle);
      const button = query(toggle)!;
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(button.getAttribute("aria-controls")!)).not.toBeNull();
      expect(query(content)).not.toBeNull();
    }
  });

  it("keeps what is open for the session", async () => {
    await render();
    click("automation-history-toggle");
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(query("automation-history-toggle")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers Clear only while the runs it clears are in view", async () => {
    await render();
    expect(query("automation-history-clear")).toBeNull();
    click("automation-history-toggle");
    expect(query("automation-history-clear")).not.toBeNull();
  });
});

describe("keyboard and screen reader", () => {
  it("moves with the arrow keys, runs with Ctrl+Enter or Cmd+Enter and edits with Enter", async () => {
    await render();
    const first = query("automation-item-macro-1")!;
    act(() => first.focus());
    key(first, "ArrowDown");
    expect(document.activeElement).toBe(query("automation-item-workflow-1"));
    key(document.activeElement!, "Enter", { ctrlKey: true });
    expect(storeFns.runAutomation).toHaveBeenCalledWith("workflow-1");
    key(document.activeElement!, "Enter", { metaKey: true });
    expect(storeFns.runAutomation).toHaveBeenCalledTimes(2);
    key(document.activeElement!, "Enter");
    expect(storeFns.runAutomation).toHaveBeenCalledTimes(2);
    expect((query("automation-editor-name") as HTMLInputElement).value).toBe("Deploy prep");
    click("automation-editor-cancel");
    act(() => query("automation-item-workflow-1")!.focus());
    key(document.activeElement!, "End");
    expect(document.activeElement).toBe(query("automation-item-workflow-2"));
    key(document.activeElement!, "d");
    expect(document.activeElement).toBe(query("automation-item-workflow-1"));
  });

  it("leaves Enter and letters on a row's button to the button", async () => {
    await render();
    const start = query("automation-start-workflow-1")!;
    act(() => start.focus());
    key(start, "Enter");
    key(start, "Enter", { ctrlKey: true });
    key(start, "s");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(query("automation-editor-dialog")).toBeNull();
    expect(document.activeElement).toBe(start);
  });

  it("keeps the keys of an open menu in the menu", async () => {
    await render();
    openAutomationRowMenu("workflow-1");
    const entry = query("automation-menu-schedule-workflow-1")!;
    act(() => entry.focus());
    key(entry, "ArrowUp");
    key(entry, "Home");
    expect(document.activeElement!.getAttribute("role")).not.toBe("treeitem");
    key(entry, "Enter");
    expect(storeFns.openScheduleEditor).toHaveBeenCalledTimes(1);
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
  });

  it("names the list, every row with its state, and every control with its automation", async () => {
    await render();
    act(() => useAppStore.setState({ automationRuns: [failedRun("workflow-1")] }));
    expect(query("automation-list")!.getAttribute("aria-label")).toBe("Automations");
    const label = (id: string) => query(id)!.getAttribute("aria-label");
    expect(label("automation-item-macro-1")).toBe("Sudo login");
    expect(label("automation-item-workflow-1")).toBe("Deploy prep, Failed");
    expect(label("automation-item-workflow-2")).toBe("Answer on match, Triggers on");
    expect(label("automation-edit-macro-1")).toBe("Edit Sudo login");
    expect(label("automation-more-macro-1")).toBe("More actions for Sudo login");
    // Every button in the sidebar has a name.
    for (const button of query("automation-sidebar")!.querySelectorAll("button")) {
      const name = button.getAttribute("aria-label") ?? button.textContent ?? "";
      expect(name.trim(), button.outerHTML).not.toBe("");
    }
  });

  it.each([
    ["with automations", library],
    ["empty", []],
  ])("has no a11y violations %s", async (_name, automations) => {
    await render(automations);
    act(() => useAppStore.setState({ automationRuns: [failedRun("workflow-1")] }));
    click("schedules-section-toggle");
    click("automation-history-toggle");
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
