import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowListItem } from "./WorkflowListItem";
import { withTooltip } from "@/test/tooltip";
import type { Workflow, WorkflowStep, WorkflowTrigger } from "@/types/workflow";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    name: "Bootstrap",
    description: "",
    tags: [],
    steps: [{ kind: "send-command", command: "whoami" }],
    triggers: [{ kind: "manual" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function handlers() {
  return {
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(w: Workflow, running = false, h = handlers()) {
  act(() => {
    root.render(withTooltip(<WorkflowListItem workflow={w} running={running} {...h} />));
  });
  return h;
}

describe("WorkflowListItem", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders name, step-count badge, and a kind-joined preview", () => {
    const steps: WorkflowStep[] = [
      { kind: "send-command", command: "a" },
      { kind: "wait", delayMs: 10 },
    ];
    render(workflow({ steps }));
    expect(query("workflow-name-w1")?.textContent).toBe("Bootstrap");
    expect(query("workflow-steps-w1")?.textContent).toBe("2 steps");
    expect(query("workflow-preview-w1")?.textContent).toBe("send-command → wait");
  });

  it("shows the Run action (not Stop) when not running", () => {
    render(workflow(), false);
    expect(query("workflow-run-w1")).not.toBeNull();
    expect(query("workflow-stop-w1")).toBeNull();
  });

  it("shows the Stop action (not Run) when running", () => {
    render(workflow(), true);
    expect(query("workflow-stop-w1")).not.toBeNull();
    expect(query("workflow-run-w1")).toBeNull();
  });

  it("marks the on-connect trigger only when bound to at least one connection", () => {
    const bound: WorkflowTrigger[] = [{ kind: "on-connect", connectionIds: ["c1"] }];
    render(workflow({ triggers: bound }));
    expect(query("workflow-on-connect-w1")).not.toBeNull();
    expect(query("workflow-on-connect-w1")?.textContent).toContain("on-connect");
  });

  it("does not mark on-connect when the trigger binds no connections", () => {
    const empty: WorkflowTrigger[] = [{ kind: "on-connect", connectionIds: [] }];
    render(workflow({ triggers: empty }));
    expect(query("workflow-on-connect-w1")).toBeNull();
  });

  it("runs on click and stops the click from bubbling to the row", () => {
    const h = render(workflow(), false);
    act(() => query("workflow-run-w1")?.click());
    expect(h.onRun).toHaveBeenCalledWith("w1");
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it("cancels via the Stop action while running", () => {
    const h = render(workflow(), true);
    act(() => query("workflow-stop-w1")?.click());
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    expect(h.onRun).not.toHaveBeenCalled();
  });

  it("wires edit / duplicate / export / delete to their handlers", () => {
    const h = render(workflow());
    act(() => query("workflow-edit-w1")?.click());
    expect(h.onEdit).toHaveBeenCalledWith("w1");
    act(() => query("workflow-duplicate-w1")?.click());
    expect(h.onDuplicate).toHaveBeenCalledWith("w1");
    act(() => query("workflow-export-w1")?.click());
    expect(h.onExport).toHaveBeenCalledWith("w1");
    act(() => query("workflow-delete-w1")?.click());
    expect(h.onDelete).toHaveBeenCalledWith("w1");
  });

  it("runs the workflow on row double-click", () => {
    const h = render(workflow());
    act(() => {
      query("workflow-item-w1")?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(h.onRun).toHaveBeenCalledWith("w1");
  });
});
