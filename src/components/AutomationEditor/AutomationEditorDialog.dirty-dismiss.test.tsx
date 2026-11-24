/**
 * Regression tests for UX2-004 (#4314): the editor must not drop an automation
 * on Escape, a scrim click or Cancel. Every kind of edit counts; a clean editor
 * closes immediately.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { click, clickScrim, pressEscape, typeInto, unsavedPromptOpen } from "@/test/dirtyDismiss";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import {
  automationWith,
  chooseFrom,
  chooseStep,
  mountEditor,
  type EditorHarness,
} from "@/test/automationEditorHarness";

setupConnectionsRegion();
setupSettingsRegion();

let editor: EditorHarness;
afterEach(() => editor.unmount());

const stored = automationWith([
  { kind: "type-keys", chunks: [{ data: "ls\r", delayMs: 0 }], timing: "recorded", recorded: true },
  { kind: "send-command", command: "sudo -v" },
]);

async function open(isNew = false): Promise<void> {
  editor = await mountEditor(stored, { isNew });
}

describe("AutomationEditorDialog — dirty dismiss (UX2-004)", () => {
  it.each([
    ["Escape", () => pressEscape("automation-editor-name")],
    ["scrim click", () => clickScrim("automation-editor-dialog")],
    ["Cancel", () => click("automation-editor-cancel")],
  ])("%s on a dirty form asks before discarding", async (_label, dismiss) => {
    await open();
    typeInto("automation-editor-name", "Prod login v2");
    dismiss();
    expect(editor.onClose).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it.each<[string, () => Promise<void> | void]>([
    ["a deleted step", () => chooseStep("1", "delete")],
    ["a moved step", () => chooseStep("1", "up")],
    [
      "edited keys",
      () => {
        click("automation-editor-step-toggle-0");
        typeInto("automation-editor-keys-text-0-0", "ls -l\\r");
      },
    ],
    [
      "keys that do not parse yet",
      () => {
        click("automation-editor-step-toggle-0");
        typeInto("automation-editor-keys-text-0-0", "\\q");
      },
    ],
    [
      "an added trigger",
      async () => {
        click("automation-editor-when-toggle");
        await chooseFrom("automation-editor-add-trigger", "automation-editor-add-trigger-hotkey");
      },
    ],
    [
      "tags",
      () => {
        click("automation-editor-tags-toggle");
        typeInto("automation-editor-tags", "ops");
      },
    ],
  ])("%s counts as unsaved", async (_label, edit) => {
    await open();
    await edit();
    pressEscape("automation-editor-name");
    expect(editor.onClose).not.toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(true);
  });

  it("an edit that was taken back does not", async () => {
    await open();
    typeInto("automation-editor-name", "Prod login v2");
    typeInto("automation-editor-name", stored.name);
    await chooseStep("1", "delete");
    click("automation-editor-step-undo");
    pressEscape("automation-editor-name");
    expect(editor.onClose).toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(false);
  });

  it("Discard on the prompt closes the editor", async () => {
    await open();
    typeInto("automation-editor-name", "Prod login v2");
    click("automation-editor-cancel");
    click("unsaved-changes-just-close");
    expect(editor.onClose).toHaveBeenCalled();
  });

  it.each([false, true])("a clean editor closes on Escape (new: %s)", async (isNew) => {
    await open(isNew);
    pressEscape("automation-editor-name");
    expect(editor.onClose).toHaveBeenCalled();
    expect(unsavedPromptOpen()).toBe(false);
  });
});
