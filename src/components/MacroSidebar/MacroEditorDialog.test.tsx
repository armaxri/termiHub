import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  AUTHORED_STEP_DELAY_MS,
  MacroEditorDialog,
  type MacroEditorResult,
} from "./MacroEditorDialog";
import { runMacroPlayback } from "@/services/macroPlayback";
import { withTooltip } from "@/test/tooltip";
import type { Macro } from "@/types/macro";

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

const macro: Macro = {
  id: "macro-1",
  name: "Deploy sequence",
  description: "Runs the deploy",
  tags: ["ops", "release"],
  steps: [
    { data: "step-one\r", delayMs: 0 },
    { data: "step-two\r", delayMs: 50 },
    { data: "step-three\r", delayMs: 100 },
  ],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("MacroEditorDialog", () => {
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

  function render(props: Partial<Parameters<typeof MacroEditorDialog>[0]> = {}) {
    const onSave = props.onSave ?? vi.fn();
    const onOpenChange = props.onOpenChange ?? vi.fn();
    act(() => {
      root.render(
        withTooltip(
          <MacroEditorDialog
            open={props.open ?? true}
            macro={props.macro === undefined ? macro : props.macro}
            onOpenChange={onOpenChange}
            onSave={onSave}
          />
        )
      );
    });
    return { onSave, onOpenChange };
  }

  it("pre-fills the fields and step list from the macro", () => {
    render();
    expect((query("macro-editor-name") as HTMLInputElement).value).toBe("Deploy sequence");
    expect((query("macro-editor-description") as HTMLInputElement).value).toBe("Runs the deploy");
    expect((query("macro-editor-tags") as HTMLInputElement).value).toBe("ops, release");
    expect(query("macro-editor-step-0")).not.toBeNull();
    expect(query("macro-editor-step-1")).not.toBeNull();
    expect(query("macro-editor-step-2")).not.toBeNull();
  });

  it("saves the edited name, description and tags", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    setInput("macro-editor-name", "Renamed");
    setInput("macro-editor-description", "New desc");
    setInput("macro-editor-tags", "a, b, a");

    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();

    expect(onSave).toHaveBeenCalledTimes(1);
    const result = onSave.mock.calls[0][0] as MacroEditorResult;
    expect(result.name).toBe("Renamed");
    expect(result.description).toBe("New desc");
    // De-duplicated tag list.
    expect(result.tags).toEqual(["a", "b"]);
    expect(result.steps).toHaveLength(3);
  });

  it("deletes an individual step before saving", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    act(() => (query("macro-editor-step-delete-1") as HTMLButtonElement).click());
    // The middle step is gone; the list re-indexes to two steps.
    expect(query("macro-editor-step-2")).toBeNull();

    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as MacroEditorResult;
    expect(result.steps.map((s) => s.data)).toEqual(["step-one\r", "step-three\r"]);
  });

  it("reorders steps with the move-up control", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    act(() => (query("macro-editor-step-up-1") as HTMLButtonElement).click());
    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();

    const result = onSave.mock.calls[0][0] as MacroEditorResult;
    expect(result.steps.map((s) => s.data)).toEqual(["step-two\r", "step-one\r", "step-three\r"]);
  });

  it("enables Save with a valid name and at least one step", () => {
    render();
    // Pre-filled edit mode: name is populated and the macro has steps.
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Save when the name is emptied", () => {
    render();
    setInput("macro-editor-name", "   ");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not call onSave while the name is invalid", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });

    setInput("macro-editor-name", "");
    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();

    expect(onSave).not.toHaveBeenCalled();
  });

  it("re-enables Save once a valid name is restored", () => {
    render();
    setInput("macro-editor-name", "");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
    setInput("macro-editor-name", "Restored");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Save when all steps are removed", () => {
    render();
    act(() => (query("macro-editor-step-delete-2") as HTMLButtonElement).click());
    act(() => (query("macro-editor-step-delete-1") as HTMLButtonElement).click());
    act(() => (query("macro-editor-step-delete-0") as HTMLButtonElement).click());
    expect(query("macro-editor-no-steps")).not.toBeNull();
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows recorded control characters in the editable escape notation", () => {
    render({
      macro: { ...macro, steps: [{ data: "ls\r", delayMs: 0 }, { data: "\x03\x1b[A", delayMs: 5 }] },
    });
    expect((query("macro-editor-step-data-0") as HTMLInputElement).value).toBe("ls\\r");
    expect((query("macro-editor-step-data-1") as HTMLInputElement).value).toBe("\\x03\\e[A");
  });

  it("saves untouched recorded steps byte-identical", async () => {
    const tricky: Macro = {
      ...macro,
      steps: [
        { data: "C:\\dir\r", delayMs: 0 },
        { data: "\x1b[1;5A\x7f\x03", delayMs: 30 },
      ],
    };
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ macro: tricky, onSave });
    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();
    expect((onSave.mock.calls[0][0] as MacroEditorResult).steps).toEqual(tricky.steps);
  });

  it("corrects a recorded step's text", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });
    setInput("macro-editor-step-data-1", "step-2-fixed\\r");
    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();
    const result = onSave.mock.calls[0][0] as MacroEditorResult;
    expect(result.steps.map((s) => s.data)).toEqual([
      "step-one\r",
      "step-2-fixed\r",
      "step-three\r",
    ]);
    // Delays are preserved when only the text changes.
    expect(result.steps.map((s) => s.delayMs)).toEqual([0, 50, 100]);
  });

  it("blocks Save and explains an invalid escape", () => {
    render();
    setInput("macro-editor-step-data-0", "echo \\q");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(query("macro-editor-step-error-0")?.textContent).toContain("\\q");
    setInput("macro-editor-step-data-0", "echo ok\\r");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(false);
    expect(query("macro-editor-step-error-0")).toBeNull();
  });

  it("blocks Save when a step's input is empty", () => {
    render();
    setInput("macro-editor-step-data-2", "");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
    expect(query("macro-editor-step-error-2")?.textContent).toContain("empty");
  });

  it("adds a step with the authored default delay and appends Enter", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });
    act(() => (query("macro-editor-add-step") as HTMLButtonElement).click());
    expect(query("macro-editor-step-3")).not.toBeNull();
    // A fresh empty step blocks Save until filled.
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
    setInput("macro-editor-step-data-3", "exit");
    act(() => (query("macro-editor-step-enter-3") as HTMLButtonElement).click());
    expect((query("macro-editor-step-data-3") as HTMLInputElement).value).toBe("exit\\r");

    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();
    const result = onSave.mock.calls[0][0] as MacroEditorResult;
    expect(result.steps[3]).toEqual({ data: "exit\r", delayMs: AUTHORED_STEP_DELAY_MS });
  });

  it("keeps each step's text attached to it when reordering", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render({ onSave });
    setInput("macro-editor-step-data-0", "first-edited\\r");
    act(() => (query("macro-editor-step-down-0") as HTMLButtonElement).click());
    expect((query("macro-editor-step-data-1") as HTMLInputElement).value).toBe("first-edited\\r");
    act(() => (query("macro-editor-save") as HTMLButtonElement).click());
    await flush();
    const result = onSave.mock.calls[0][0] as MacroEditorResult;
    expect(result.steps).toEqual([
      { data: "step-two\r", delayMs: 50 },
      { data: "first-edited\r", delayMs: 0 },
      { data: "step-three\r", delayMs: 100 },
    ]);
  });

  describe("authoring a new macro (macro = null)", () => {
    it("opens blank titled New Macro with one empty step and Save disabled", () => {
      render({ macro: null });
      expect(document.body.textContent).toContain("New Macro");
      expect((query("macro-editor-name") as HTMLInputElement).value).toBe("");
      expect((query("macro-editor-step-data-0") as HTMLInputElement).value).toBe("");
      expect(query("macro-editor-step-1")).toBeNull();
      expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
    });

    it("authors a multi-step macro that plays exactly like the recorded equivalent", async () => {
      const onSave = vi.fn().mockResolvedValue(undefined);
      render({ macro: null, onSave });
      setInput("macro-editor-name", "Hand written");
      setInput("macro-editor-tags", "ops");
      setInput("macro-editor-step-data-0", "cd /srv\\r");
      act(() => (query("macro-editor-add-step") as HTMLButtonElement).click());
      setInput("macro-editor-step-data-1", "tail -f log\\r");
      act(() => (query("macro-editor-add-step") as HTMLButtonElement).click());
      setInput("macro-editor-step-data-2", "\\x03");

      act(() => (query("macro-editor-save") as HTMLButtonElement).click());
      await flush();

      const result = onSave.mock.calls[0][0] as MacroEditorResult;
      expect(result.name).toBe("Hand written");
      expect(result.tags).toEqual(["ops"]);
      // The same shape the recorder produces for those keystrokes.
      const recordedEquivalent = [
        { data: "cd /srv\r", delayMs: 0 },
        { data: "tail -f log\r", delayMs: AUTHORED_STEP_DELAY_MS },
        { data: "\x03", delayMs: AUTHORED_STEP_DELAY_MS },
      ];
      expect(result.steps).toEqual(recordedEquivalent);

      // Playback injects exactly the same bytes for authored and recorded steps.
      const play = async (steps: typeof recordedEquivalent) => {
        const injected: string[] = [];
        const handle = runMacroPlayback(
          steps,
          (data) => {
            injected.push(data);
            return true;
          },
          { timingMode: "instant" }
        );
        expect((await handle.done).status).toBe("completed");
        return injected;
      };
      expect(await play(result.steps)).toEqual(await play(recordedEquivalent));
      expect(await play(result.steps)).toEqual(["cd /srv\r", "tail -f log\r", "\x03"]);
    });
  });
});
