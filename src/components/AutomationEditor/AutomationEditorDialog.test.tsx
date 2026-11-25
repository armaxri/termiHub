/**
 * The one automation editor (#5818, slice 7): fields, step list, saving, the
 * round trip of every golden automation, validation timing and the footer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import {
  automationWith,
  chooseFrom,
  chooseStep,
  click,
  mountEditor,
  press,
  query,
  typeText,
  valueOf,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { checkA11y } from "@/test/axe";
import { openMenu } from "@/test/automationRowMenu";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { leaveField } from "@/test/leaveField";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { Automation } from "@/types/generated/Automation";

setupConnectionsRegion();
setupSettingsRegion();

const TESTDATA = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src-tauri/src/automations/testdata/legacy.expected.json"
);
const golden = (JSON.parse(readFileSync(TESTDATA, "utf8")) as { automations: Automation[] })
  .automations;

const stored = automationWith(
  [
    { kind: "send-command", command: "sudo -v" },
    { kind: "wait", delayMs: 500 },
    { kind: "run-automation", automationId: "a-log" },
  ],
  { description: "Log in and check health", tags: ["ops", "prod"] }
);
const recorded = automationWith([
  {
    kind: "type-keys",
    chunks: [
      { data: "l", delayMs: 0 },
      { data: "s", delayMs: 90 },
      { data: "\r", delayMs: 120 },
    ],
    timing: "recorded",
    recorded: true,
  },
]);

let editor: EditorHarness;
const open = async (automation: Automation, isNew = false) => {
  editor = await mountEditor(automation, { isNew });
};
const saveButton = () => query("automation-editor-save") as HTMLButtonElement;
const blocked = () => saveButton().getAttribute("aria-disabled") === "true";
const nameError = () => document.getElementById("automation-editor-name-error");

beforeEach(() => {
  useAppStore.setState({
    ...automationLibraryState([automationWith([], { id: "a-log", name: "tail app log" }), stored]),
    schedules: [],
  });
});
afterEach(() => editor.unmount());

describe("fields and steps", () => {
  it("shows the stored fields and one line per step", async () => {
    await open(stored);
    expect(valueOf("automation-editor-name")).toBe("Deploy prep");
    expect(valueOf("automation-editor-description")).toBe("Log in and check health");
    click("automation-editor-tags-toggle");
    expect(valueOf("automation-editor-tags")).toBe("ops, prod");
    expect(query("automation-editor-step-kind-0")?.textContent).toBe("Run command");
    expect(query("automation-editor-step-summary-0")?.textContent).toBe("sudo -v");
    expect(query("automation-editor-step-summary-1")?.textContent).toBe("0.5 s");
    expect(query("automation-editor-step-summary-2")?.textContent).toBe("tail app log");
  });

  it("keeps the description a short single line (#5757)", async () => {
    await open(stored);
    const input = query("automation-editor-description") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.maxLength).toBe(80);
  });

  it("saves trimmed fields and de-duplicated tags, and leaves the rest alone", async () => {
    await open(stored);
    typeText("automation-editor-name", "  Renamed ");
    typeText("automation-editor-description", "  spaced  desc ");
    click("automation-editor-tags-toggle");
    typeText("automation-editor-tags", "a, b, a");
    expect(await editor.save()).toEqual({
      ...stored,
      name: "Renamed",
      description: "spaced desc",
      tags: ["a", "b"],
    });
  });

  it("drops an emptied description", async () => {
    await open(stored);
    typeText("automation-editor-description", "   ");
    expect(await editor.save()).not.toHaveProperty("description");
  });

  it.each([
    ["type-keys", "automation-editor-keys-text-3-0"],
    ["send-command", "automation-editor-step-command-3"],
    ["wait", "automation-editor-step-delay-3"],
    ["wait-for-output", "automation-editor-wfo-pattern-3"],
    ["conditional", "automation-editor-cond-left-3"],
    ["run-script", "automation-editor-step-script-3"],
  ])("adds a %s step, opened, with the focus on its first field", async (kind, field) => {
    await open(stored);
    await chooseFrom("automation-editor-add-step", `automation-editor-add-step-${kind}`);
    expect(query("automation-editor-step-toggle-3")?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(query(field));
  });

  it("keeps the Add step menu inside the dialog, where it can be clicked (#1868)", async () => {
    await open(stored);
    openMenu("automation-editor-add-step");
    expect(
      query("automation-editor-dialog")!.contains(query("automation-editor-add-step-wait"))
    ).toBe(true);
  });

  it("moves a step with the arrow keys on its handle, keeping the focus there", async () => {
    await open(stored);
    (query("automation-editor-step-grip-1") as HTMLElement).focus();
    press("automation-editor-step-grip-1", "ArrowUp");
    expect(query("automation-editor-step-kind-0")?.dataset.kind).toBe("wait");
    expect(document.activeElement).toBe(query("automation-editor-step-grip-0"));
    expect(query("automation-editor-live")?.textContent).toBe("Step moved to position 1 of 3.");
    press("automation-editor-step-grip-0", "ArrowUp");
    press("automation-editor-step-grip-0", "ArrowDown");
    press("automation-editor-step-grip-1", "ArrowDown");
    expect((await editor.save()).steps.map((s) => s.kind)).toEqual([
      "send-command",
      "run-automation",
      "wait",
    ]);
  });

  it("moves a step from its menu, not past either end", async () => {
    await open(stored);
    openMenu("automation-editor-step-more-0");
    expect(query("automation-editor-step-up-0")?.getAttribute("aria-disabled")).toBe("true");
    click("automation-editor-step-down-0");
    await flushAsync();
    expect((await editor.save()).steps.map((s) => s.kind)).toEqual([
      "wait",
      "send-command",
      "run-automation",
    ]);
  });

  it("deletes a step, moves the focus to its neighbor and offers Undo (R-167)", async () => {
    await open(stored);
    await chooseStep("1", "delete");
    expect(query("automation-editor-step-2")).toBeNull();
    expect(query("automation-editor-step-deleted")?.textContent).toContain("Deleted Wait.");
    expect(document.activeElement).toBe(query("automation-editor-step-toggle-1"));
    expect(query("automation-editor-live")?.textContent).toContain("Undo is available");
    click("automation-editor-step-undo");
    expect(query("automation-editor-step-deleted")).toBeNull();
    expect(query("automation-editor-step-kind-1")?.dataset.kind).toBe("wait");
    typeText("automation-editor-name", "x");
    expect((await editor.save()).steps).toEqual(stored.steps);
  });

  it("duplicates a step right below it", async () => {
    await open(stored);
    await chooseStep("0", "duplicate");
    expect((await editor.save()).steps).toEqual([stored.steps[0], ...stored.steps]);
  });

  it("offers every other automation to run, never itself", async () => {
    await open(automationWith([{ kind: "run-automation", automationId: "gone" }], { id: "a-log" }));
    click("automation-editor-step-toggle-0");
    const picker = query("automation-editor-step-automation-0")!;
    expect(picker.textContent).toContain("Missing automation");
    press("automation-editor-step-automation-0", "Enter");
    await flushAsync();
    const options = Array.from(document.querySelectorAll('[role="option"]'), (o) => o.textContent);
    expect(options).toEqual(["Missing automation", "Deploy prep"]);
  });

  it("has no accessibility violations, every section open", async () => {
    await open(golden.find((a) => a.name === "Deploy prep")!);
    click("automation-editor-steps-toggle-all");
    click("automation-editor-tags-toggle");
    await checkA11y(query("automation-editor-dialog")!);
  });
});

describe("round trip (#5818)", () => {
  it.each(golden.map((a) => [a.name, a] as const))(
    "saving %s unchanged stores nothing",
    async (_name, automation) => {
      await open(automation);
      if (automation.steps.length === 0) return; // nothing to save: an empty one is blocked
      click("automation-editor-save");
      await flushAsync();
      expect(editor.onSave).toHaveBeenCalledWith({
        automation: null,
        run: false,
        schedule: false,
      });
    }
  );

  it.each(golden.filter((a) => a.steps.length > 0).map((a) => [a.name, a] as const))(
    "renaming %s keeps everything else byte for byte",
    async (_name, automation) => {
      await open(automation);
      // Opened rows mount every field; mounting one must not rewrite its value.
      click("automation-editor-steps-toggle-all");
      typeText("automation-editor-name", "Renamed");
      expect(JSON.stringify(await editor.save())).toBe(
        JSON.stringify({ ...automation, name: "Renamed" })
      );
    }
  );
});

describe("saving", () => {
  it("keeps the dialog and its edits when saving fails", async () => {
    await open(stored);
    editor.onSave.mockRejectedValueOnce(new Error("disk full"));
    typeText("automation-editor-name", "Renamed");
    click("automation-editor-save");
    await flushAsync();
    expect(valueOf("automation-editor-name")).toBe("Renamed");
    expect(editor.onClose).not.toHaveBeenCalled();
  });

  it("Save and run saves, then asks to run", async () => {
    await open(stored);
    typeText("automation-editor-name", "Renamed");
    click("automation-editor-save-run");
    await flushAsync();
    expect(editor.onSave).toHaveBeenCalledWith({
      automation: { ...stored, name: "Renamed" },
      run: true,
      schedule: false,
    });
  });

  it("always stores a new automation, edited or not", async () => {
    await open(stored, true);
    expect(await editor.save()).toEqual(stored);
  });
});

describe("the primary action (#5755, #5810)", () => {
  const footer = () =>
    Array.from(document.querySelectorAll(".ui-modal__foot button"), (b) => b.textContent);
  const isPrimary = (id: string) => query(id)!.className.includes("ui-btn--primary");
  const enter = (id: string) => press(id, "Enter");

  it("is Save and run for a new automation", async () => {
    await open(stored, true);
    expect(footer()).toEqual(["Cancel", "Save", "Save and run"]);
    expect(isPrimary("automation-editor-save-run")).toBe(true);
    expect(isPrimary("automation-editor-save")).toBe(false);
    enter("automation-editor-name");
    await flushAsync();
    expect(editor.onSave.mock.calls[0][0].run).toBe(true);
  });

  it("is Save for an existing one", async () => {
    await open(stored);
    expect(footer()).toEqual(["Cancel", "Save and run", "Save"]);
    expect(isPrimary("automation-editor-save")).toBe(true);
    typeText("automation-editor-description", "x");
    enter("automation-editor-description");
    await flushAsync();
    expect(editor.onSave.mock.calls[0][0].run).toBe(false);
  });

  it("is never run by Enter in a step: typing a command must not run it", async () => {
    await open(stored, true);
    enter("automation-editor-step-command-0");
    click("automation-editor-when-toggle");
    await chooseFrom("automation-editor-add-trigger", "automation-editor-add-trigger-hotkey");
    enter("automation-trigger-binding-0");
    await flushAsync();
    expect(editor.onSave).not.toHaveBeenCalled();
  });
});

describe("validation timing (#5917)", () => {
  const blank = automationWith([], { name: "" });
  const blankKeys = automationWith([{ kind: "type-keys", chunks: [], timing: "recorded" }], {
    name: "",
  });

  it("opens a new automation clean, with Save reachable but blocked", async () => {
    await open(blankKeys, true);
    expect(nameError()).toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(blocked()).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it("shows a field's error once it was edited and left, not the others'", async () => {
    await open(blankKeys, true);
    typeText("automation-editor-name", "x");
    typeText("automation-editor-name", "");
    expect(nameError()).toBeNull();
    leaveField(query("automation-editor-name"));
    expect(nameError()?.textContent).toBe("Name is required.");
    expect(query("automation-editor-keys-error-0-0")).toBeNull();
    typeText("automation-editor-name", "Named");
    expect(nameError()).toBeNull();
  });

  it.each(["automation-editor-save", "automation-editor-save-run"])(
    "%s on an invalid form saves nothing, shows every error and focuses the first",
    async (button) => {
      await open(blankKeys, true);
      click(button);
      await flushAsync();
      expect(editor.onSave).not.toHaveBeenCalled();
      expect(nameError()?.textContent).toBe("Name is required.");
      expect(query("automation-editor-keys-error-0-0")?.textContent).toBe(
        "Enter the keys to type."
      );
      expect(document.activeElement).toBe(query("automation-editor-name"));
    }
  );

  it("with only the steps missing, says so and focuses Add step", async () => {
    await open({ ...blank, name: "Named" }, true);
    expect(query("automation-editor-no-steps")?.textContent).toBe(
      "No steps yet. Add the first one."
    );
    click("automation-editor-save");
    await flushAsync();
    expect(query("automation-editor-no-steps")?.textContent).toBe("Add at least one step.");
    expect(document.activeElement).toBe(query("automation-editor-add-step"));
  });

  it("opens a collapsed, nested step whose field blocks Save", async () => {
    await open(
      automationWith([
        {
          kind: "loop",
          loop: { kind: "count", count: 2 },
          body: [{ kind: "wait", delayMs: 1, retry: { count: 0 } }],
        },
      ])
    );
    expect(query("automation-editor-step-body-0")).toBeNull();
    click("automation-editor-save");
    await flushAsync();
    expect(document.activeElement).toBe(query("automation-editor-step-retry-count-0-body-0"));
  });

  it("opens the closed When it runs section on a trigger that blocks Save", async () => {
    await open(
      automationWith([{ kind: "wait", delayMs: 1 }], {
        triggers: [{ kind: "on-output-match", connectionIds: ["c"], pattern: "" }],
      })
    );
    click("automation-editor-when-toggle");
    expect(query("automation-editor-when")).toBeNull();
    click("automation-editor-save");
    await flushAsync();
    expect(document.activeElement).toBe(query("automation-trigger-pattern-0"));
  });

  it("blocks Save once every step is gone", async () => {
    await open(recorded);
    await chooseStep("0", "delete");
    expect(blocked()).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });
});
