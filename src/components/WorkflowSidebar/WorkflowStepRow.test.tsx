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

// Machine-local settings + store seams for the run-script file source (#4310).
const settingsState = vi.hoisted(() => ({
  current: { workflowScriptSourceAllowlist: [] as string[] } as Record<string, unknown>,
}));
const updateSettings = vi.hoisted(() => vi.fn(async (_next: Record<string, unknown>) => {}));
const localReadFile = vi.hoisted(() => vi.fn(async (_path: string) => "line1\nline2"));
vi.mock("@/store/useProjectedSettings", () => ({
  useProjectedSettings: () => settingsState.current,
}));
vi.mock("@/store/appStore", () => ({
  useAppStore: (selector: (s: { updateSettings: typeof updateSettings }) => unknown) =>
    selector({ updateSettings }),
}));
const openDialog = vi.hoisted(() => vi.fn(async (_opts?: unknown): Promise<string | null> => null));
vi.mock("@/services/nativeDialog", () => ({
  open: (opts?: unknown) => openDialog(opts),
}));
vi.mock("@/services/api", () => ({
  localReadFile: (path: string) => localReadFile(path),
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

  describe("run-script file source (#4310, FEC2-001)", () => {
    beforeEach(() => {
      settingsState.current = { workflowScriptSourceAllowlist: [] };
    });

    const flush = async () => {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    };

    it("shows the real path and flags an unconfirmed file as not runnable", () => {
      render({
        step: {
          kind: "run-script",
          script: "echo harmless",
          sourcePath: "/home/u/.ssh/id_ed25519",
        },
      });
      expect(query("workflow-editor-step-source-path-0")?.textContent).toBe(
        "/home/u/.ssh/id_ed25519"
      );
      expect(query("workflow-editor-step-source-status-0")?.textContent).toMatch(
        /not confirmed on this machine/i
      );
      expect(query("workflow-editor-step-source-confirm-0")).not.toBeNull();
    });

    it("confirming a shown path adds exactly that path to the machine-local allowlist", async () => {
      render({ step: { kind: "run-script", script: "", sourcePath: "/home/u/deploy.sh" } });
      act(() => query("workflow-editor-step-source-confirm-0")?.click());
      await flush();
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ workflowScriptSourceAllowlist: ["/home/u/deploy.sh"] })
      );
    });

    it("shows a confirmed path as read on each run without a confirm button", () => {
      settingsState.current = { workflowScriptSourceAllowlist: ["/home/u/deploy.sh"] };
      render({ step: { kind: "run-script", script: "", sourcePath: "/home/u/deploy.sh" } });
      expect(query("workflow-editor-step-source-status-0")?.textContent).toMatch(
        /read from this file/i
      );
      expect(query("workflow-editor-step-source-confirm-0")).toBeNull();
    });

    it("picking a file sets the path, loads its contents and confirms it", async () => {
      openDialog.mockResolvedValueOnce("/home/u/setup.sh");
      const h = render({ step: { kind: "run-script", script: "" } });
      act(() => query("workflow-editor-step-source-pick-0")?.click());
      await flush();
      expect(localReadFile).toHaveBeenCalledWith("/home/u/setup.sh");
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ workflowScriptSourceAllowlist: ["/home/u/setup.sh"] })
      );
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "run-script",
        script: "line1\nline2",
        sourcePath: "/home/u/setup.sh",
      });
    });

    it("a cancelled pick changes nothing", async () => {
      openDialog.mockResolvedValueOnce(null);
      const h = render({ step: { kind: "run-script", script: "x" } });
      act(() => query("workflow-editor-step-source-pick-0")?.click());
      await flush();
      expect(localReadFile).not.toHaveBeenCalled();
      expect(h.onChange).not.toHaveBeenCalled();
    });

    it("detaching the file removes the sourcePath and keeps the visible script", () => {
      const h = render({ step: { kind: "run-script", script: "keep", sourcePath: "/a.sh" } });
      act(() => query("workflow-editor-step-source-detach-0")?.click());
      expect(h.onChange).toHaveBeenLastCalledWith("u1", { kind: "run-script", script: "keep" });
    });

    it("editing the script body detaches the file so the visible script is what runs", () => {
      const h = render({ step: { kind: "run-script", script: "old", sourcePath: "/a.sh" } });
      typeInto(query("workflow-editor-step-script-0"), "echo new");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", { kind: "run-script", script: "echo new" });
    });
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

  describe("loop step", () => {
    it("renders an iteration count field for a count loop and patches it", () => {
      const h = render({
        step: { kind: "loop", loop: { kind: "count", count: 3 }, body: [] },
      });
      const field = query("workflow-editor-loop-count-0") as HTMLInputElement;
      expect(field.value).toBe("3");
      typeInto(field, "7");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "loop",
        loop: { kind: "count", count: 7 },
        body: [],
      });
    });

    it("renders the while-condition builder and the body container", () => {
      render({
        step: {
          kind: "loop",
          loop: { kind: "while", condition: { left: "${iteration}", op: "lt", right: "5" } },
          body: [{ kind: "send-command", command: "go" }],
        },
      });
      expect((query("workflow-editor-cond-left-0-loop") as HTMLInputElement).value).toBe(
        "${iteration}"
      );
      expect((query("workflow-editor-cond-right-0-loop") as HTMLInputElement).value).toBe("5");
      // No count field is shown in while mode.
      expect(query("workflow-editor-loop-count-0")).toBeNull();
      expect(query("workflow-editor-branch-0-body")?.textContent).toContain("Do (1)");
    });

    it("edits a body sub-step's command through its own detail editor", () => {
      const h = render({
        step: {
          kind: "loop",
          loop: { kind: "count", count: 2 },
          body: [{ kind: "send-command", command: "old" }],
        },
      });
      const field = query("workflow-editor-step-command-0-body-0") as HTMLInputElement;
      expect(field.value).toBe("old");
      typeInto(field, "new");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "loop",
        loop: { kind: "count", count: 2 },
        body: [{ kind: "send-command", command: "new" }],
      });
    });
  });

  describe("wait-for-output step", () => {
    it("renders the pattern field and patches it", () => {
      const h = render({ step: { kind: "wait-for-output", pattern: "login:" } });
      const field = query("workflow-editor-wfo-pattern-0") as HTMLInputElement;
      expect(field.value).toBe("login:");
      typeInto(field, "ready>");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "wait-for-output",
        pattern: "ready>",
      });
    });

    it("toggles the regex flag on and back off", () => {
      const h = render({ step: { kind: "wait-for-output", pattern: "x" } });
      act(() => query("workflow-editor-wfo-regex-0")?.click());
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "wait-for-output",
        pattern: "x",
        isRegex: true,
      });
    });

    it("patches the optional timeout", () => {
      const h = render({ step: { kind: "wait-for-output", pattern: "x" } });
      typeInto(query("workflow-editor-wfo-timeout-0"), "5000");
      expect(h.onChange).toHaveBeenLastCalledWith("u1", {
        kind: "wait-for-output",
        pattern: "x",
        timeoutMs: 5000,
      });
    });
  });
});
