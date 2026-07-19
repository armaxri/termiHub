import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroEditorDialog, type MacroEditorResult } from "./MacroEditorDialog";
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
            macro={props.macro ?? macro}
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

  it("disables Save when the name is emptied", () => {
    render();
    setInput("macro-editor-name", "   ");
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Save when all steps are removed", () => {
    render();
    act(() => (query("macro-editor-step-delete-2") as HTMLButtonElement).click());
    act(() => (query("macro-editor-step-delete-1") as HTMLButtonElement).click());
    act(() => (query("macro-editor-step-delete-0") as HTMLButtonElement).click());
    expect(query("macro-editor-no-steps")).not.toBeNull();
    expect((query("macro-editor-save") as HTMLButtonElement).disabled).toBe(true);
  });
});
