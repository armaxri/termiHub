/**
 * Regression tests for UX2-004 (#4314): the macro editor must not drop typed
 * steps on Escape, a scrim click or Cancel. A dirty form asks first; a clean
 * one closes immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MacroEditorDialog } from "./MacroEditorDialog";
import { withTooltip } from "@/test/tooltip";
import { flushAsync } from "@/test/flushAsync";
import { click, clickScrim, pressEscape, typeInto, unsavedPromptOpen } from "@/test/dirtyDismiss";
import type { Macro } from "@/types/macro";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

const macro: Macro = {
  id: "macro-1",
  name: "Deploy",
  tags: [],
  steps: [{ data: "make deploy\r", delayMs: 0 }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

async function render() {
  const onOpenChange = vi.fn();
  act(() => {
    root.render(
      withTooltip(
        <MacroEditorDialog open macro={macro} onOpenChange={onOpenChange} onSave={vi.fn()} />
      )
    );
  });
  await flushAsync();
  return onOpenChange;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MacroEditorDialog — dirty dismiss (UX2-004)", () => {
  it.each([
    ["Escape", () => pressEscape("macro-editor-name")],
    ["scrim click", () => clickScrim("macro-editor-dialog")],
    ["Cancel", () => click("macro-editor-cancel")],
  ])("%s on a dirty form asks before discarding", async (_label, dismiss) => {
    const onOpenChange = await render();
    typeInto("macro-editor-name", "Deploy v2");
    dismiss();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("Discard on the prompt closes the editor", async () => {
    const onOpenChange = await render();
    typeInto("macro-editor-name", "Deploy v2");
    click("macro-editor-cancel");
    click("unsaved-changes-just-close");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a clean form closes on Escape without asking", async () => {
    const onOpenChange = await render();
    pressEscape("macro-editor-name");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(unsavedPromptOpen()).toBe(false);
  });
});
