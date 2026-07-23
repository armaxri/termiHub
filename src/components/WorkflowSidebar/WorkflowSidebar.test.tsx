import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowSidebar } from "./WorkflowSidebar";
import { withTooltip } from "@/test/tooltip";
import type { Workflow } from "@/types/workflow";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
    },
  };
});

import { useAppStore } from "@/store/appStore";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function setSearch(value: string) {
  const input = query("workflow-search") as HTMLInputElement;
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

const sampleWorkflows: Workflow[] = [
  {
    id: "workflow-1",
    name: "Prod login",
    description: "Log in and check",
    tags: ["ops", "release"],
    steps: [{ kind: "send-command", command: "sudo -v" }],
    triggers: [{ kind: "manual" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "workflow-2",
    name: "Banner",
    tags: [],
    steps: [{ kind: "wait", delayMs: 100 }],
    triggers: [{ kind: "on-connect", connectionIds: ["conn-1"] }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

describe("WorkflowSidebar", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    useAppStore.setState({
      workflows: [],
      macros: [],
      connections: [],
      workflowRun: null,
      saveWorkflowToBackend: vi.fn().mockResolvedValue(undefined),
      deleteWorkflowFromBackend: vi.fn().mockResolvedValue(undefined),
      importWorkflows: vi.fn().mockResolvedValue(0),
      runWorkflow: vi.fn().mockResolvedValue(undefined),
      cancelWorkflowRun: vi.fn(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(withTooltip(<WorkflowSidebar />));
    });
  }

  it("shows the empty message when no workflows exist", () => {
    render();
    expect(query("workflow-empty-message")).not.toBeNull();
    expect(query("workflow-list")).toBeNull();
  });

  it("renders a row for each workflow", () => {
    useAppStore.setState({ workflows: sampleWorkflows });
    render();
    expect(query("workflow-list")).not.toBeNull();
    expect(query("workflow-item-workflow-1")).not.toBeNull();
    expect(query("workflow-item-workflow-2")).not.toBeNull();
    expect(query("workflow-name-workflow-1")?.textContent).toBe("Prod login");
  });

  it("marks on-connect-triggered workflows", () => {
    useAppStore.setState({ workflows: sampleWorkflows });
    render();
    expect(query("workflow-on-connect-workflow-2")).not.toBeNull();
    expect(query("workflow-on-connect-workflow-1")).toBeNull();
  });

  it("filters the list by the search query across name/description/tags", () => {
    useAppStore.setState({ workflows: sampleWorkflows });
    render();

    setSearch("banner");
    expect(query("workflow-item-workflow-2")).not.toBeNull();
    expect(query("workflow-item-workflow-1")).toBeNull();

    setSearch("release");
    expect(query("workflow-item-workflow-1")).not.toBeNull();
    expect(query("workflow-item-workflow-2")).toBeNull();
  });

  it("shows a no-results state when the query matches nothing", () => {
    useAppStore.setState({ workflows: sampleWorkflows });
    render();
    setSearch("nonexistent");
    expect(query("workflow-no-results")).not.toBeNull();
    expect(query("workflow-list")).toBeNull();
  });

  it("runs a workflow when its Run action is clicked", () => {
    const runWorkflow = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workflows: sampleWorkflows, runWorkflow });
    render();
    act(() => (query("workflow-run-workflow-1") as HTMLButtonElement).click());
    expect(runWorkflow).toHaveBeenCalledWith("workflow-1");
  });

  it("shows a stop affordance for the running workflow and cancels on click", () => {
    const cancelWorkflowRun = vi.fn();
    useAppStore.setState({
      workflows: sampleWorkflows,
      cancelWorkflowRun,
      workflowRun: {
        workflowId: "workflow-1",
        workflowName: "Prod login",
        tabId: "tab-1",
        total: 1,
        completed: 0,
      },
    });
    render();
    expect(query("workflow-stop-workflow-1")).not.toBeNull();
    expect(query("workflow-run-workflow-1")).toBeNull();
    act(() => (query("workflow-stop-workflow-1") as HTMLButtonElement).click());
    expect(cancelWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("duplicates a workflow through the backend and reports success", async () => {
    const saveWorkflowToBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workflows: sampleWorkflows, saveWorkflowToBackend });
    render();

    act(() => (query("workflow-duplicate-workflow-1") as HTMLButtonElement).click());
    await flush();

    expect(saveWorkflowToBackend).toHaveBeenCalledTimes(1);
    const saved = saveWorkflowToBackend.mock.calls[0][0] as Workflow;
    expect(saved.name).toBe("Copy of Prod login");
    expect(saved.id).not.toBe("workflow-1");
    expect(saved.steps).toEqual(sampleWorkflows[0].steps);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation before deleting and does not delete on click alone", () => {
    const deleteWorkflowFromBackend = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ workflows: [sampleWorkflows[0]], deleteWorkflowFromBackend });
    render();

    expect(query("confirm-delete-dialog")).toBeNull();
    act(() => (query("workflow-delete-workflow-1") as HTMLButtonElement).click());
    expect(query("confirm-delete-dialog")).not.toBeNull();
    expect(deleteWorkflowFromBackend).not.toHaveBeenCalled();
  });

  it("opens the editor prefilled when editing a workflow", () => {
    useAppStore.setState({ workflows: sampleWorkflows });
    render();
    expect(query("workflow-editor-dialog")).toBeNull();
    act(() => (query("workflow-edit-workflow-1") as HTMLButtonElement).click());
    expect(query("workflow-editor-dialog")).not.toBeNull();
    expect((query("workflow-editor-name") as HTMLInputElement).value).toBe("Prod login");
  });
});
