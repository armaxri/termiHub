/**
 * Regression tests for UX2-004 (#4314): the workflow editor must not drop a
 * multi-step workflow on Escape, a scrim click or Cancel. Edits to the scalar
 * fields and to the step list both count; a clean editor closes immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog";
import { withTooltip } from "@/test/tooltip";
import { flushAsync } from "@/test/flushAsync";
import { click, clickScrim, pressEscape, typeInto, unsavedPromptOpen } from "@/test/dirtyDismiss";
import type { Workflow } from "@/types/workflow";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

const workflow: Workflow = {
  id: "workflow-1",
  name: "Prod login",
  tags: [],
  steps: [
    { kind: "send-command", command: "sudo -v" },
    { kind: "wait", delayMs: 500 },
  ],
  triggers: [{ kind: "manual" }],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

async function render() {
  const onOpenChange = vi.fn();
  act(() => {
    root.render(
      withTooltip(
        <WorkflowEditorDialog
          open
          workflow={workflow}
          macros={[]}
          connections={[]}
          onOpenChange={onOpenChange}
          onSave={vi.fn()}
        />
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

describe("WorkflowEditorDialog — dirty dismiss (UX2-004)", () => {
  it.each([
    ["Escape", () => pressEscape("workflow-editor-name")],
    ["scrim click", () => clickScrim("workflow-editor-dialog")],
    ["Cancel", () => click("workflow-editor-cancel")],
  ])("%s on a dirty form asks before discarding", async (_label, dismiss) => {
    const onOpenChange = await render();
    typeInto("workflow-editor-name", "Prod login v2");
    dismiss();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("an edited step list counts as unsaved", async () => {
    const onOpenChange = await render();
    click("workflow-editor-step-delete-1");
    pressEscape("workflow-editor-name");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("Discard on the prompt closes the editor", async () => {
    const onOpenChange = await render();
    typeInto("workflow-editor-name", "Prod login v2");
    click("workflow-editor-cancel");
    click("unsaved-changes-just-close");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a clean editor closes on Escape without asking", async () => {
    const onOpenChange = await render();
    pressEscape("workflow-editor-name");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(unsavedPromptOpen()).toBe(false);
  });
});
