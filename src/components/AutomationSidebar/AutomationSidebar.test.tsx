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
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => dialogSave(...args),
  open: (...args: unknown[]) => dialogOpen(...args),
}));
const fsWriteTextFile = vi.fn();
const fsReadTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...args: unknown[]) => fsWriteTextFile(...args),
  readTextFile: (...args: unknown[]) => fsReadTextFile(...args),
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
import { parseMacroEnvelope } from "@/services/macroIo";
import { parseWorkflowEnvelope } from "@/services/workflowIo";
import { resetRememberedRunTargetChoice } from "@/components/Automations/runTargetChoice";
import { AUTOMATION_JUST_SAVED_MS } from "./AutomationRow";
import { AutomationSidebar } from "./AutomationSidebar";
import { useAutomationSections } from "./automationSections";

setupConnectionsRegion();

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

function key(el: Element, keyName: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true }));
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
  saveMacroToBackend: vi.fn(),
  saveWorkflowToBackend: vi.fn(),
  setWorkflowTriggersEnabled: vi.fn(),
  importMacros: vi.fn(),
  importWorkflows: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  cancelMacroPlayback: vi.fn(),
  cancelMacroPlaybackOnTab: vi.fn(),
  openScheduleEditor: vi.fn(),
  toggleMacroRecording: vi.fn(),
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
  storeFns.importMacros.mockResolvedValue(1);
  storeFns.importWorkflows.mockResolvedValue({
    imported: 1,
    workflowsWithLocalProcess: 0,
    localProcessSteps: 0,
    removedScriptSourcePaths: [],
  });
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({ ...storeFns });
  useAutomationSections.setState(useAutomationSections.getInitialState());
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
  await act(async () => root.render(withTooltip(<AutomationSidebar />)));
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
    expect(query("automation-item-workflow-2")!.textContent).toBe("Answer on matchArmed");
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
    expect(storeFns.toggleMacroRecording).toHaveBeenCalledTimes(1);
    click("automation-empty-new-btn");
    expect(query("workflow-editor-dialog")).not.toBeNull();
  });

  it("keeps Import reachable and disables Export all", async () => {
    await render([]);
    openMenu("automation-toolbar-more");
    expect(query("automation-import-btn")!.hasAttribute("data-disabled")).toBe(false);
    expect(query("automation-export-all-btn")!.hasAttribute("data-disabled")).toBe(true);
  });
});

describe("toolbar (R-037)", () => {
  it("names every action in text", async () => {
    await render();
    expect(query("automation-new-btn")!.textContent).toBe("New");
    expect(query("automation-record-btn")!.textContent).toBe("Record");
    openMenu("automation-toolbar-more");
    expect(query("automation-import-btn")!.textContent).toBe("Import…");
    expect(query("automation-export-all-btn")!.textContent).toBe("Export all…");
  });

  it("creates step by step or from typed keystrokes, in the editor that fits", async () => {
    await render();
    openMenu("automation-new-btn");
    click("automation-new-steps");
    expect(query("workflow-editor-dialog")).not.toBeNull();
    click("workflow-editor-cancel");
    openMenu("automation-new-btn");
    click("automation-new-keys");
    expect(query("macro-editor-dialog")).not.toBeNull();
  });

  it("records, and says so while it does", async () => {
    await render();
    click("automation-record-btn");
    expect(storeFns.toggleMacroRecording).toHaveBeenCalledTimes(1);
    act(() => useAppStore.setState({ macroRecording: true }));
    expect(query("automation-record-btn")!.textContent).toBe("Stop recording");
  });

  it("keeps New in view and folds the rest into one menu when narrow", async () => {
    await render();
    ro.resize(150);
    expect(query("automation-new-btn")!.textContent).toBe("New");
    expect(query("automation-toolbar-more")).toBeNull();
    openMenu("automation-toolbar-overflow");
    // Text, and no sub-menu to dig through.
    for (const id of [
      "automation-record-btn",
      "automation-import-btn",
      "automation-export-all-btn",
    ]) {
      expect(query(id)!.getAttribute("role"), id).toBe("menuitem");
      expect(query(id)!.getAttribute("aria-haspopup"), id).toBeNull();
    }
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
    expect(query("run-targets-dialog")!.textContent).toContain('Run "Sudo login"');
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

  it("runs on a row double-click, but not on a double-click of its buttons", async () => {
    await render();
    const dbl = (testId: string) =>
      act(() => {
        query(testId)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
    dbl("automation-edit-macro-1");
    dbl("automation-arm-toggle-workflow-2");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    dbl("automation-name-macro-1");
    expect(storeFns.runAutomation).toHaveBeenCalledWith("macro-1");
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
    expect(query("automation-targets-workflow-1")).toBeNull();
    click("automation-stop-workflow-1");
    expect(storeFns.cancelWorkflowRun).toHaveBeenCalledWith();
    // Enter and double-click never start it a second time.
    key(query("automation-item-workflow-1")!, "ArrowDown");
    key(query("automation-item-workflow-1")!, "Enter");
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
    expect(query("automation-running-workflow-1")!.textContent).toBe("Running 2");
    expect(query("automation-target-r1")!.textContent).toContain("web-11 / 3");
    expect(query("automation-target-r2")!.textContent).toContain("db-22 / 3");
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
      timingMode: "real-time" as const,
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
    expect(query("automation-target-tab-a")!.textContent).toContain("web-13 / 4");
    expect(query("automation-target-tab-b")!.textContent).toContain("web-21 / 4");
    click("automation-target-stop-tab-b");
    expect(storeFns.cancelMacroPlaybackOnTab).toHaveBeenCalledWith("tab-b");
  });
});

describe("markers", () => {
  it("arms and disarms on the name line without running or opening anything (R-077)", async () => {
    await render();
    const marker = query("automation-armed-workflow-2")!;
    expect(marker.getAttribute("aria-label")).toBe("Runs automatically: on output match of prod");
    // Marker and switch sit in the row's header, beside Run: no second line.
    const primary = query("automation-primary-workflow-2")!;
    expect(primary.contains(marker)).toBe(true);
    expect(primary.contains(query("automation-arm-toggle-workflow-2"))).toBe(true);
    click("automation-arm-toggle-workflow-2");
    expect(storeFns.setWorkflowTriggersEnabled).toHaveBeenCalledWith("workflow-2", false);
    key(query("automation-arm-toggle-workflow-2")!, "Enter");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(query("workflow-editor-dialog")).toBeNull();
  });

  it("shows Off, meaning the trigger, and arms again", async () => {
    await render([{ ...triggered, triggersEnabled: false }]);
    expect(query("automation-armed-workflow-2")!.textContent).toBe("Off");
    expect(query("automation-armed-workflow-2")!.getAttribute("aria-label")).toMatch(
      /^Trigger off/
    );
    expect(query("automation-arm-toggle-workflow-2")!.getAttribute("aria-label")).toBe(
      "Turn on the automatic trigger of Answer on match"
    );
    click("automation-arm-toggle-workflow-2");
    expect(storeFns.setWorkflowTriggersEnabled).toHaveBeenCalledWith("workflow-2", true);
  });

  it("reports a failed disarm", async () => {
    storeFns.setWorkflowTriggersEnabled.mockRejectedValue(new Error("disk full"));
    await render();
    click("automation-arm-toggle-workflow-2");
    await flushAsync();
    expect(toastError).toHaveBeenCalledWith('Failed to disarm "Answer on match"', {
      description: "disk full",
    });
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
    expect(query("automation-armed-workflow-2")!.textContent).toBe("");
    expect(query("automation-armed-workflow-2")!.getAttribute("aria-label")).toMatch(/^Runs auto/);
    expect(query("automation-failed-workflow-2")!.textContent).toBe("");
    expect(query("automation-failed-workflow-2")!.getAttribute("aria-label")).toContain(
      "Last automatic run failed"
    );
    // Run and the switch stay.
    expect(query("automation-start-workflow-2")).not.toBeNull();
    expect(query("automation-arm-toggle-workflow-2")).not.toBeNull();
    ro.resize(320);
    expect(query("automation-armed-workflow-2")!.textContent).toBe("Armed");
  });
});

describe("row actions", () => {
  it.each([
    ["macro-1", "macro-editor-dialog"],
    ["workflow-1", "workflow-editor-dialog"],
  ])("opens the editor that fits %s, from the button and the menu", async (id, dialog) => {
    await render();
    click(`automation-edit-${id}`);
    expect(query(dialog)).not.toBeNull();
    click(dialog.replace("-dialog", "-cancel"));
    expect(query(dialog)).toBeNull();
    choose(id, "edit");
    expect(query(dialog)).not.toBeNull();
  });

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
    expect(toastError).toHaveBeenCalledWith('Failed to duplicate "Sudo login"', {
      description: "disk full",
    });
  });

  it("starts a new automation from typed keystrokes (was: promote a macro)", async () => {
    await render();
    choose("macro-1", "use-in-new");
    expect((query("workflow-editor-name") as HTMLInputElement).value).toBe("Sudo login");
    expect(query("workflow-editor-step-0")).not.toBeNull();
    click("workflow-editor-cancel");
    openAutomationRowMenu("workflow-1");
    expect(query("automation-menu-use-in-new-workflow-1")).toBeNull();
  });

  it("deletes only after a confirmation", async () => {
    await render();
    choose("workflow-1", "delete");
    expect(storeFns.deleteAutomationFromBackend).not.toHaveBeenCalled();
    expect(query("confirm-delete-dialog")!.textContent).toContain(
      'Delete automation "Deploy prep"? This cannot be undone.'
    );
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

describe("editors", () => {
  it("saves a hand-written keystroke automation and keeps the dialog on failure", async () => {
    storeFns.saveMacroToBackend.mockRejectedValueOnce(new Error("disk full"));
    await render();
    click("automation-edit-macro-1");
    click("macro-editor-save");
    await flushAsync();
    expect(toastError).toHaveBeenCalledWith("Failed to save automation: disk full");
    expect(query("macro-editor-dialog")).not.toBeNull();
    click("macro-editor-save");
    await flushAsync();
    expect(query("macro-editor-dialog")).toBeNull();
    expect(storeFns.saveMacroToBackend).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "macro-1", name: "Sudo login", tags: ["ops"] })
    );
  });

  it("creates a keystroke automation with a fresh id", async () => {
    await render();
    openMenu("automation-new-btn");
    click("automation-new-keys");
    const set = (testId: string, value: string) => {
      const input = query(testId) as HTMLInputElement;
      const proto =
        input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      act(() => {
        Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    set("macro-editor-name", "Greet");
    if (!query("macro-editor-step-data-0")) click("macro-editor-add-step");
    set("macro-editor-step-data-0", "echo hi\\r");
    click("macro-editor-save");
    await flushAsync();
    expect(storeFns.saveMacroToBackend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Greet",
        steps: [expect.objectContaining({ data: "echo hi\r" })],
      })
    );
    expect(storeFns.saveMacroToBackend.mock.calls[0][0].id).toMatch(/^macro-/);
  });

  describe("mark the saved row (#5687)", () => {
    afterEach(() => {
      vi.useRealTimers();
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    });

    it.each([
      ["macro-1", "macro-editor-save"],
      ["workflow-2", "workflow-editor-save"],
    ])("highlights %s, scrolls it into view, then unmarks it", async (id, save) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const scrolled: Array<{ testId: string | null; opts: unknown }> = [];
      HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, opts?: unknown) {
        scrolled.push({ testId: this.getAttribute("data-testid"), opts });
      } as HTMLElement["scrollIntoView"];
      await act(async () => {
        setLibrary(library);
        root.render(withTooltip(<AutomationSidebar />));
      });
      click(`automation-edit-${id}`);
      scrolled.length = 0;
      click(save);
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
    });
  });
});

describe("files", () => {
  it("exports the whole library to one file both old importers read", async () => {
    dialogSave.mockResolvedValue("/tmp/a.json");
    await render();
    openMenu("automation-toolbar-more");
    click("automation-export-all-btn");
    await flushAsync();
    expect(dialogSave.mock.calls[0][0].defaultPath).toBe("termihub-automations.json");
    const json = fsWriteTextFile.mock.calls[0][1] as string;
    expect(parseMacroEnvelope(json).map((m) => m.name)).toEqual(["Sudo login"]);
    expect(parseWorkflowEnvelope(json).map((w) => w.name)).toEqual([
      "Deploy prep",
      "Answer on match",
    ]);
    expect(toastSuccess).toHaveBeenCalledWith("Exported 3 automations");
  });

  it.each([
    ["macro-1", "termihub-automation-sudo-login.json", parseMacroEnvelope, "Sudo login"],
    ["workflow-1", "termihub-automation-deploy-prep.json", parseWorkflowEnvelope, "Deploy prep"],
  ])("exports %s on its own", async (id, path, parse, name) => {
    dialogSave.mockResolvedValue("/tmp/a.json");
    await render();
    choose(id, "export");
    await flushAsync();
    expect(dialogSave.mock.calls[0][0].defaultPath).toBe(path);
    expect(parse(fsWriteTextFile.mock.calls[0][1] as string).map((x) => x.name)).toEqual([name]);
  });

  async function importJson(json: string): Promise<void> {
    dialogOpen.mockResolvedValue("/tmp/in.json");
    fsReadTextFile.mockResolvedValue(json);
    await render();
    openMenu("automation-toolbar-more");
    click("automation-import-btn");
    await flushAsync();
  }

  it.each([
    ["a macro file", '{"version":1,"macros":[]}', 1, 0],
    ["a workflow file", '{"version":1,"workflows":[]}', 0, 1],
    ["a file with both", '{"version":1,"macros":[],"workflows":[]}', 1, 1],
  ])("imports %s without a toast", async (_name, json, macros, workflows) => {
    await importJson(json);
    expect(storeFns.importMacros).toHaveBeenCalledTimes(macros);
    expect(storeFns.importWorkflows).toHaveBeenCalledTimes(workflows);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("imports nothing from a file that is malformed in one list", async () => {
    await importJson('{"version":1,"macros":[],"workflows":[{"name":""}]}');
    expect(storeFns.importMacros).not.toHaveBeenCalled();
    expect(storeFns.importWorkflows).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringMatching(/^Failed to import automations: Invalid workflow file/)
    );
  });

  it("flags imported local-process steps and removed script paths, and stays up", async () => {
    storeFns.importWorkflows.mockResolvedValue({
      imported: 2,
      workflowsWithLocalProcess: 1,
      localProcessSteps: 2,
      removedScriptSourcePaths: ["/home/u/x.sh"],
    });
    await importJson('{"version":1,"workflows":[]}');
    const [title, options] = toastInfo.mock.calls[0];
    expect(title).toBe("Imported 2 automations");
    expect(options.duration).toBe(Infinity);
    expect(options.description).toContain("1 imported automation contain 2 local-process steps");
    expect(options.description).toContain("/home/u/x.sh");
  });

  it("does nothing when the dialogs are canceled", async () => {
    dialogSave.mockResolvedValue(null);
    dialogOpen.mockResolvedValue(null);
    await render();
    openMenu("automation-toolbar-more");
    click("automation-export-all-btn");
    await flushAsync();
    openMenu("automation-toolbar-more");
    click("automation-import-btn");
    await flushAsync();
    expect(fsWriteTextFile).not.toHaveBeenCalled();
    expect(fsReadTextFile).not.toHaveBeenCalled();
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
  it("moves with the arrow keys and runs the focused automation with Enter", async () => {
    await render();
    const first = query("automation-item-macro-1")!;
    act(() => first.focus());
    key(first, "ArrowDown");
    expect(document.activeElement).toBe(query("automation-item-workflow-1"));
    key(document.activeElement!, "Enter");
    expect(storeFns.runAutomation).toHaveBeenCalledWith("workflow-1");
    key(document.activeElement!, "End");
    expect(document.activeElement).toBe(query("automation-item-workflow-2"));
    key(document.activeElement!, "d");
    expect(document.activeElement).toBe(query("automation-item-workflow-1"));
  });

  it("leaves Enter and letters on a row's button to the button", async () => {
    await render();
    const edit = query("automation-edit-workflow-1")!;
    act(() => edit.focus());
    key(edit, "Enter");
    key(edit, "s");
    expect(storeFns.runAutomation).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(edit);
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
    expect(label("automation-item-workflow-2")).toBe("Answer on match, Armed");
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
