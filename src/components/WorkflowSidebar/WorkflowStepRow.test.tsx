import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowStepRow, type WorkflowStepEntry } from "./WorkflowStepRow";
import type { WorkflowStep } from "@/types/workflow";
import type { Macro } from "@/types/macro";

// dnd-kit needs a DndContext/SortableContext ancestor to run for real; stub the
// sortable hook (as the AgentNode tests do) so a single row mounts in isolation.
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));
vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function typeInto(el: HTMLElement | null, value: string) {
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

interface RenderOpts {
  step: WorkflowStep;
  index?: number;
  total?: number;
  macros?: Macro[];
}

function handlers() {
  return { onChange: vi.fn(), onMove: vi.fn(), onDelete: vi.fn() };
}

function render({ step, index = 0, total = 3, macros = [] }: RenderOpts, h = handlers()) {
  const entry: WorkflowStepEntry = { uid: "u1", step };
  act(() => {
    root.render(
      <WorkflowStepRow
        entry={entry}
        index={index}
        total={total}
        macros={macros}
        onChange={h.onChange}
        onMove={h.onMove}
        onDelete={h.onDelete}
      />
    );
  });
  return h;
}

describe("WorkflowStepRow", () => {
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

  it("shows the 1-based index and the step kind label", () => {
    render({ step: { kind: "send-command", command: "" }, index: 2 });
    expect(query("workflow-editor-step-kind-2")?.textContent).toBe("send-command");
    expect(query("workflow-editor-step-2")?.textContent).toContain("3");
  });

  it("disables move-up on the first row and move-down on the last row", () => {
    render({ step: { kind: "wait", delayMs: 100 }, index: 0, total: 3 });
    expect((query("workflow-editor-step-up-0") as HTMLButtonElement).disabled).toBe(true);
    expect((query("workflow-editor-step-down-0") as HTMLButtonElement).disabled).toBe(false);
  });

  it("invokes onMove with the direction and onDelete with the uid", () => {
    const h = render({ step: { kind: "wait", delayMs: 100 }, index: 1, total: 3 });
    act(() => query("workflow-editor-step-down-1")?.click());
    expect(h.onMove).toHaveBeenCalledWith(1, 1);
    act(() => query("workflow-editor-step-up-1")?.click());
    expect(h.onMove).toHaveBeenCalledWith(1, -1);
    act(() => query("workflow-editor-step-delete-1")?.click());
    expect(h.onDelete).toHaveBeenCalledWith("u1");
  });

  it("renders a command field for send-command and patches the command", () => {
    const h = render({ step: { kind: "send-command", command: "whoami" } });
    const field = query("workflow-editor-step-command-0") as HTMLInputElement;
    expect(field.value).toBe("whoami");
    typeInto(field, "uptime");
    expect(h.onChange).toHaveBeenLastCalledWith("u1", { kind: "send-command", command: "uptime" });
  });

  it("renders a script textarea and per-line delay for run-script", () => {
    const h = render({ step: { kind: "run-script", script: "a\nb" } });
    const textarea = query("workflow-editor-step-script-0") as HTMLTextAreaElement;
    expect(textarea.value).toBe("a\nb");
    expect(query("workflow-editor-step-linedelay-0")).not.toBeNull();
    typeInto(textarea, "echo hi");
    expect(h.onChange).toHaveBeenLastCalledWith("u1", { kind: "run-script", script: "echo hi" });
  });

  it("renders a macro picker listing the available macros for run-macro", () => {
    const macros: Macro[] = [
      {
        id: "mac-1",
        name: "Warmup",
        tags: [],
        steps: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    render({ step: { kind: "run-macro", macroId: "mac-1" }, macros });
    // The Radix Select trigger renders the selected macro's name.
    const picker = query("workflow-editor-step-macro-0");
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain("Warmup");
  });

  it("renders a delay field for wait", () => {
    render({ step: { kind: "wait", delayMs: 250 } });
    const delay = query("workflow-editor-step-delay-0") as HTMLInputElement;
    expect(delay).not.toBeNull();
    expect(delay.value).toBe("250");
  });

  it("renders program + ordered argument rows for run-local-process", () => {
    render({ step: { kind: "run-local-process", program: "/bin/echo", args: ["hi there"] } });
    expect((query("workflow-editor-step-program-0") as HTMLInputElement).value).toBe("/bin/echo");
    expect((query("workflow-editor-step-arg-0-0") as HTMLInputElement).value).toBe("hi there");
  });

  it("appends a blank argument via Add argument", () => {
    const h = render({ step: { kind: "run-local-process", program: "p", args: ["one"] } });
    act(() => query("workflow-editor-step-arg-add-0")?.click());
    expect(h.onChange).toHaveBeenLastCalledWith("u1", {
      kind: "run-local-process",
      program: "p",
      args: ["one", ""],
    });
  });

  it("removes an argument by index, preserving the rest", () => {
    const h = render({
      step: { kind: "run-local-process", program: "p", args: ["a", "b"] },
    });
    act(() => query("workflow-editor-step-arg-remove-0-0")?.click());
    expect(h.onChange).toHaveBeenLastCalledWith("u1", {
      kind: "run-local-process",
      program: "p",
      args: ["b"],
    });
  });

  describe("conditional step", () => {
    const conditional = (over: Partial<Extract<WorkflowStep, { kind: "conditional" }>> = {}) =>
      ({
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [],
        ...over,
      }) satisfies WorkflowStep;

    it("renders the condition builder with the current operands", () => {
      render({ step: conditional() });
      expect((query("workflow-editor-cond-left-0") as HTMLInputElement).value).toBe("${env}");
      expect((query("workflow-editor-cond-right-0") as HTMLInputElement).value).toBe("prod");
      expect(query("workflow-editor-cond-op-0")).not.toBeNull();
    });

    it("patches the left operand", () => {
      const h = render({ step: conditional() });
      typeInto(query("workflow-editor-cond-left-0"), "${branch}");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "conditional",
        condition: { left: "${branch}", op: "eq", right: "prod" },
        then: [],
      });
    });

    it("shows then/else branch containers with their step counts", () => {
      render({
        step: conditional({
          then: [{ kind: "send-command", command: "go" }],
          else: [{ kind: "wait", delayMs: 5 }],
        }),
      });
      expect(query("workflow-editor-branch-0-then")?.textContent).toContain("Then (1)");
      expect(query("workflow-editor-branch-0-else")?.textContent).toContain("Else (optional) (1)");
    });

    it("edits a nested then sub-step's command through its own detail editor", () => {
      const h = render({
        step: conditional({ then: [{ kind: "send-command", command: "old" }] }),
      });
      const field = query("workflow-editor-step-command-0-then-0") as HTMLInputElement;
      expect(field.value).toBe("old");
      typeInto(field, "new");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [{ kind: "send-command", command: "new" }],
      });
    });

    it("deletes a then sub-step by index", () => {
      const h = render({
        step: conditional({
          then: [
            { kind: "send-command", command: "one" },
            { kind: "send-command", command: "two" },
          ],
        }),
      });
      act(() => query("workflow-editor-substep-delete-0-then-0")?.click());
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [{ kind: "send-command", command: "two" }],
      });
    });

    it("drops the else branch to undefined when its last sub-step is deleted", () => {
      const h = render({
        step: conditional({ else: [{ kind: "send-command", command: "only" }] }),
      });
      act(() => query("workflow-editor-substep-delete-0-else-0")?.click());
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "conditional",
        condition: { left: "${env}", op: "eq", right: "prod" },
        then: [],
      });
    });
  });
});
