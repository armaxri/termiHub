import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowEditorDialog, type WorkflowEditorResult } from "./WorkflowEditorDialog";
import { withTooltip } from "@/test/tooltip";
import type { Workflow } from "@/types/workflow";
import type { Macro } from "@/types/macro";
import type { SavedConnection } from "@/types/connection";

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

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open the "Add step…" dropdown and wait for the portalled menu items. */
async function openAddStepMenu() {
  const trigger = query("workflow-editor-add-step") as HTMLButtonElement;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
    );
  });
  for (let i = 0; i < 20 && !query("workflow-editor-add-step-wait"); i++) {
    await act(async () => {
      await nextFrame();
    });
  }
}

const macros: Macro[] = [
  {
    id: "macro-1",
    name: "tail app log",
    tags: [],
    steps: [{ data: "tail -f app.log\r", delayMs: 0 }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

const connections: SavedConnection[] = [
  { id: "conn-1", name: "prod-web-1", config: {} as never, folderId: null },
  { id: "conn-2", name: "prod-web-2", config: {} as never, folderId: null },
];

const workflow: Workflow = {
  id: "workflow-1",
  name: "Prod login",
  description: "Log in and check health",
  tags: ["ops", "prod"],
  steps: [
    { kind: "send-command", command: "sudo -v" },
    { kind: "wait", delayMs: 500 },
    { kind: "run-macro", macroId: "macro-1" },
  ],
  triggers: [{ kind: "manual" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("WorkflowEditorDialog", () => {
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

  function render(props: Partial<Parameters<typeof WorkflowEditorDialog>[0]> = {}) {
    const onSave = props.onSave ?? vi.fn().mockResolvedValue(undefined);
    const onOpenChange = props.onOpenChange ?? vi.fn();
    act(() => {
      root.render(
        withTooltip(
          <WorkflowEditorDialog
            open={props.open ?? true}
            workflow={props.workflow ?? workflow}
            macros={props.macros ?? macros}
            connections={props.connections ?? connections}
            isNew={props.isNew ?? false}
            onOpenChange={onOpenChange}
            onSave={onSave}
          />
        )
      );
    });
    return { onSave, onOpenChange };
  }

  it("pre-fills the fields and step list from the workflow", () => {
    render();
    expect((query("workflow-editor-name") as HTMLInputElement).value).toBe("Prod login");
    expect((query("workflow-editor-description") as HTMLInputElement).value).toBe(
      "Log in and check health"
    );
    expect((query("workflow-editor-tags") as HTMLInputElement).value).toBe("ops, prod");
    expect(query("workflow-editor-step-0")).not.toBeNull();
    expect(query("workflow-editor-step-1")).not.toBeNull();
    expect(query("workflow-editor-step-2")).not.toBeNull();
    expect(query("workflow-editor-step-kind-0")?.textContent).toBe("send-command");
  });

  it("saves the edited name, description and tags", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    setInput("workflow-editor-name", "Renamed");
    setInput("workflow-editor-description", "New desc");
    setInput("workflow-editor-tags", "a, b, a");

    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.name).toBe("Renamed");
    expect(result.description).toBe("New desc");
    expect(result.tags).toEqual(["a", "b"]);
    expect(result.steps).toHaveLength(3);
  });

  it("edits a send-command step's command before saving", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    setInput("workflow-editor-step-command-0", "whoami");
    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.steps[0]).toEqual({ kind: "send-command", command: "whoami" });
  });

  it("edits run-local-process args as a discrete list (a space-containing arg stays one arg)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const lpWorkflow: Workflow = {
      ...workflow,
      steps: [{ kind: "run-local-process", program: "notify-send", args: ["--urgency"] }],
    };
    render({ onSave, workflow: lpWorkflow });

    // Add a second argument row, then type a value that contains a space.
    act(() => (query("workflow-editor-step-arg-add-0") as HTMLButtonElement).click());
    await flush();
    setInput("workflow-editor-step-arg-0-1", "hello world");

    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    // The space-containing value is a SINGLE discrete argument — never split.
    expect(result.steps[0]).toEqual({
      kind: "run-local-process",
      program: "notify-send",
      args: ["--urgency", "hello world"],
    });
  });

  it("removes a run-local-process argument row", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const lpWorkflow: Workflow = {
      ...workflow,
      steps: [{ kind: "run-local-process", program: "echo", args: ["a", "b"] }],
    };
    render({ onSave, workflow: lpWorkflow });

    act(() => (query("workflow-editor-step-arg-remove-0-0") as HTMLButtonElement).click());
    await flush();

    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.steps[0]).toEqual({ kind: "run-local-process", program: "echo", args: ["b"] });
  });

  it("adds a typed step from the Add step menu", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    await openAddStepMenu();
    const waitItem = query("workflow-editor-add-step-wait") as HTMLElement;
    expect(waitItem).not.toBeNull();
    await act(async () => {
      waitItem.click();
    });

    expect(query("workflow-editor-step-3")).not.toBeNull();
    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.steps).toHaveLength(4);
    expect(result.steps[3].kind).toBe("wait");
  });

  it("portals the Add step menu inside the dialog content, not document.body (#1868)", async () => {
    render();

    await openAddStepMenu();
    const dialog = query("workflow-editor-dialog");
    const waitItem = query("workflow-editor-add-step-wait");
    expect(dialog).not.toBeNull();
    expect(waitItem).not.toBeNull();

    // Regression guard for #1868: a modal Radix Dialog sets pointer-events: none
    // on document.body, so a menu portalled to body is dead/unclickable in a
    // real browser. The menu must live INSIDE the dialog subtree (its
    // pointer-events: auto content) — jsdom can't reproduce the pointer-events
    // failure itself, but it can prove the structural fix that prevents it.
    expect(dialog!.contains(waitItem)).toBe(true);
  });

  it("deletes an individual step before saving", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    act(() => (query("workflow-editor-step-delete-1") as HTMLButtonElement).click());
    expect(query("workflow-editor-step-2")).toBeNull();

    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.steps.map((s) => s.kind)).toEqual(["send-command", "run-macro"]);
  });

  it("reorders steps with the move-up control", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    act(() => (query("workflow-editor-step-up-1") as HTMLButtonElement).click());
    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.steps.map((s) => s.kind)).toEqual(["wait", "send-command", "run-macro"]);
  });

  it("binds a hotkey trigger and saves it", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    act(() => (query("workflow-trigger-hotkey") as HTMLButtonElement).click());
    setInput("workflow-trigger-hotkey-binding", "Ctrl+Alt+H");

    act(() => (query("workflow-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as WorkflowEditorResult;
    expect(result.triggers).toContainEqual({ kind: "hotkey", binding: "Ctrl+Alt+H" });
    expect(result.triggers).toContainEqual({ kind: "manual" });
  });

  it("disables Save when the name is emptied", () => {
    render();
    setInput("workflow-editor-name", "   ");
    expect((query("workflow-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Save and shows the empty hint when all steps are removed", () => {
    render();
    act(() => (query("workflow-editor-step-delete-2") as HTMLButtonElement).click());
    act(() => (query("workflow-editor-step-delete-1") as HTMLButtonElement).click());
    act(() => (query("workflow-editor-step-delete-0") as HTMLButtonElement).click());
    expect(query("workflow-editor-no-steps")).not.toBeNull();
    expect((query("workflow-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });
});
