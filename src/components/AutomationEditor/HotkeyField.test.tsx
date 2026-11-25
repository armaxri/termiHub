/** The hotkey of a trigger is pressed, not written, and says who else uses it (A-027). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { DEFAULT_BINDINGS, formatActionBindings } from "@/services/keybindings";
import { useAppStore } from "@/store/appStore";
import { automationLibraryState } from "@/store/slices/automationStoreState";
import {
  automationWith,
  click,
  mountEditor,
  query,
  valueOf,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { hotkeyConflict } from "./HotkeyField";

setupConnectionsRegion();
setupSettingsRegion();

const FIELD = "automation-trigger-binding-0";
let editor: EditorHarness;
afterEach(() => editor?.unmount());

async function open(binding = "") {
  useAppStore.setState(
    automationLibraryState([
      automationWith([], {
        id: "other",
        name: "Other",
        triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+J" }],
      }),
    ])
  );
  editor = await mountEditor(
    automationWith([{ kind: "wait", delayMs: 1 }], { triggers: [{ kind: "hotkey", binding }] })
  );
  click("automation-editor-when-toggle");
  await flushAsync();
}

/** Press a key; whether the browser may still act on it. */
function press(init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    query(FIELD)!.dispatchEvent(event);
  });
  return !event.defaultPrevented;
}
const hint = () => query(FIELD)!.closest(".ui-field")?.textContent ?? "";

describe("the hotkey field", () => {
  it("takes the keys that are pressed", async () => {
    await open();
    expect(press({ key: "Control", ctrlKey: true })).toBe(true);
    expect(valueOf(FIELD)).toBe("");
    press({ key: "k", code: "KeyK", ctrlKey: true, altKey: true });
    expect(valueOf(FIELD)).toBe("Ctrl+Alt+K");
    expect((await editor.save()).triggers).toEqual([{ kind: "hotkey", binding: "Ctrl+Alt+K" }]);
  });

  it.each<[string, KeyboardEventInit, RegExp]>([
    ["a plain letter", { key: "k", code: "KeyK" }, /Add Ctrl, Alt or Cmd/],
    ["a plain function key", { key: "F5", code: "F5" }, /stays with terminal programs/],
    ["a dead key", { key: "Dead", code: "Backquote", ctrlKey: true }, /starts an accent/],
  ])("refuses %s and says why", async (_what, init, why) => {
    await open("Ctrl+Alt+K");
    press(init);
    expect(valueOf(FIELD)).toBe("Ctrl+Alt+K");
    expect(hint()).toMatch(why);
  });

  it("leaves Tab and Enter alone, and Backspace clears it", async () => {
    await open("Ctrl+Alt+K");
    for (const key of ["Tab", "Enter"]) {
      expect(press({ key })).toBe(true);
      expect(valueOf(FIELD)).toBe("Ctrl+Alt+K");
    }
    press({ key: "Backspace" });
    expect(valueOf(FIELD)).toBe("");
  });

  it("an empty one blocks Save (A-022)", async () => {
    await open();
    click("automation-editor-save");
    await flushAsync();
    expect(editor.onSave).not.toHaveBeenCalled();
    expect(hint()).toContain("Press the keys.");
  });

  it("names the automation that has the same keys", async () => {
    await open("ctrl+alt+j");
    expect(hint()).toContain("is used by “Other”, so it will not start this.");
  });
});

describe("hotkeyConflict", () => {
  it("names the app shortcut that wins", () => {
    const taken = DEFAULT_BINDINGS.find((b) => b.action === "command-palette")!;
    const keys = formatActionBindings(taken.action)!;
    expect(hotkeyConflict(keys, [])).toEqual({ keys, user: taken.label });
    expect(hotkeyConflict("Ctrl+Alt+Shift+9", [])).toBeNull();
    expect(hotkeyConflict("", [])).toBeNull();
  });
});
