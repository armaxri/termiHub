/**
 * Tests for the "Run on…" multi-terminal picker (PROD-047): initial selection,
 * select-all and broadcast-group shortcuts, toggling, the Run gate, and the
 * empty state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowRunTargetsDialog } from "./WorkflowRunTargetsDialog";
import { withTooltip } from "@/test/tooltip";
import type { RunnableTarget } from "@/store/slices/workflowFanout";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const candidates: RunnableTarget[] = [
  { id: "t1", sessionId: "s1", title: "web-1" },
  { id: "t2", sessionId: "s2", title: "web-2" },
  { id: "t3", sessionId: "s3", title: "db-1" },
];

function render(props: Partial<Parameters<typeof WorkflowRunTargetsDialog>[0]> = {}): {
  onRun: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const onRun = vi.fn();
  const onOpenChange = vi.fn();
  act(() => {
    root.render(
      withTooltip(
        <WorkflowRunTargetsDialog
          open
          workflowName="Deploy"
          candidates={props.candidates ?? candidates}
          broadcastTabIds={props.broadcastTabIds ?? []}
          initialSelection={props.initialSelection ?? ["t1"]}
          onOpenChange={onOpenChange}
          onRun={onRun}
        />
      )
    );
  });
  return { onRun, onOpenChange };
}

const runButton = () => query("workflow-run-targets-run") as HTMLButtonElement;

describe("WorkflowRunTargetsDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("runs on the initial selection", () => {
    const { onRun, onOpenChange } = render();
    expect(query("workflow-run-target-t1")?.getAttribute("aria-checked")).toBe("true");
    act(() => runButton().click());
    expect(onRun).toHaveBeenCalledWith(["t1"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("selects all terminals and runs them in display order", () => {
    const { onRun } = render({ initialSelection: [] });
    act(() => query("workflow-run-targets-all")?.click());
    expect(runButton().textContent).toBe("Run on 3 terminals");
    act(() => runButton().click());
    expect(onRun).toHaveBeenCalledWith(["t1", "t2", "t3"]);
  });

  it("offers the broadcast group only when it has connected members", () => {
    render();
    expect(query("workflow-run-targets-broadcast")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);

    const { onRun } = render({ broadcastTabIds: ["t2", "t3", "gone"] });
    act(() => query("workflow-run-targets-broadcast")?.click());
    act(() => runButton().click());
    expect(onRun).toHaveBeenCalledWith(["t2", "t3"]);
  });

  it("toggles a terminal off and disables Run when nothing is selected", () => {
    const { onRun } = render();
    act(() => query("workflow-run-target-t1")?.click());
    expect(runButton().disabled).toBe(true);
    act(() => runButton().click());
    expect(onRun).not.toHaveBeenCalled();
  });

  it("shows an empty state without connected terminals", () => {
    render({ candidates: [], initialSelection: [] });
    expect(document.body.textContent).toContain("No connected terminals");
    expect(runButton().disabled).toBe(true);
  });
});
