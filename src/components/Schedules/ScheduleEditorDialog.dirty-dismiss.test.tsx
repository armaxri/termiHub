/**
 * Regression tests for UX2-004 (#4314): the schedule editor must not drop its
 * edits on Escape, a scrim click or Cancel. A dirty form asks first; a clean
 * one closes immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";
import { withTooltip } from "@/test/tooltip";
import { flushAsync } from "@/test/flushAsync";
import { click, clickScrim, pressEscape, typeInto, unsavedPromptOpen } from "@/test/dirtyDismiss";
import type { Workflow } from "@/types/workflow";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

let container: HTMLDivElement;
let root: Root;

const workflows: Workflow[] = [
  {
    id: "wf-1",
    name: "Health check",
    tags: [],
    steps: [{ kind: "send-command", command: "uptime" }],
    triggers: [],
    createdAt: "",
    updatedAt: "",
  },
];

async function render() {
  const onOpenChange = vi.fn();
  act(() => {
    root.render(
      withTooltip(
        <ScheduleEditorDialog
          open
          scheduleId="schedule-new"
          schedule={null}
          initialAction={{ kind: "workflow", workflowId: "wf-1" }}
          workflows={workflows}
          macros={[]}
          connections={[]}
          groups={[]}
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

describe("ScheduleEditorDialog — dirty dismiss (UX2-004)", () => {
  it.each([
    ["Escape", () => pressEscape("schedule-editor-name")],
    ["scrim click", () => clickScrim("schedule-editor-dialog")],
    ["Cancel", () => click("schedule-editor-cancel")],
  ])("%s on a dirty form asks before discarding", async (_label, dismiss) => {
    const onOpenChange = await render();
    typeInto("schedule-editor-name", "Nightly");
    dismiss();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("Discard on the prompt closes the editor", async () => {
    const onOpenChange = await render();
    typeInto("schedule-editor-name", "Nightly");
    click("schedule-editor-cancel");
    click("unsaved-changes-just-close");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a clean form closes on Escape without asking", async () => {
    const onOpenChange = await render();
    pressEscape("schedule-editor-name");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(unsavedPromptOpen()).toBe(false);
  });
});
