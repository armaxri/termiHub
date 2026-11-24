/**
 * The Type keys step editor (PROD-039, #3440, #5818): escape notation, byte
 * exactness, per-row delays and the typing speed saved with the step (#5820).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { runWorkflow } from "@/services/workflowRunner";
import {
  automationWith,
  click,
  mountEditor,
  pick,
  press,
  query,
  typeText,
  valueOf,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { leaveField } from "@/test/leaveField";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { Automation } from "@/types/generated/Automation";
import { ADDED_KEYS_DELAY_MS, type TypeKeysStep } from "./automationDraft";
import { SHOWN_KEY_ROWS } from "./TypeKeysFields";

setupConnectionsRegion();
setupSettingsRegion();

const recorded: TypeKeysStep = {
  kind: "type-keys",
  chunks: [
    { data: "sudo -v\r", delayMs: 0 },
    { data: "\x1b[A", delayMs: 1200 },
    { data: "\x03", delayMs: 180 },
  ],
  timing: "recorded",
  recorded: true,
};

let editor: EditorHarness;
async function open(step: TypeKeysStep = recorded, isNew = false): Promise<void> {
  editor = await mountEditor(automationWith([step]), { isNew });
  if (!isNew) click("automation-editor-step-toggle-0");
}
afterEach(() => editor.unmount());

const keysOf = (automation: Automation) => automation.steps[0] as TypeKeysStep;
const text = (row: number) => `automation-editor-keys-text-0-${row}`;
const blocked = () => query("automation-editor-save")!.getAttribute("aria-disabled") === "true";

describe("the keys", () => {
  it("shows control keys in the editable escape notation", async () => {
    await open();
    expect(valueOf(text(0))).toBe("sudo -v\\r");
    expect(valueOf(text(1))).toBe("\\e[A");
    expect(valueOf(text(2))).toBe("\\x03");
    expect(query("automation-editor-keys-hint-0")?.textContent).toContain("\\r");
  });

  it("corrects one row and keeps the others byte for byte", async () => {
    await open();
    typeText(text(1), "\\e[B");
    expect(keysOf(await editor.save())).toEqual({
      ...recorded,
      chunks: [recorded.chunks[0], { data: "\x1b[B", delayMs: 1200 }, recorded.chunks[2]],
    });
  });

  it("Enter adds an Enter key at the caret instead of saving", async () => {
    await open();
    const input = query(text(0)) as HTMLInputElement;
    act(() => input.focus());
    input.setSelectionRange(4, 7);
    press(text(0), "Enter");
    expect(valueOf(text(0))).toBe("sudo\\r\\r");
    expect(input.selectionStart).toBe(6);
    expect(editor.onSave).not.toHaveBeenCalled();
  });

  it("the Enter button adds one at the end", async () => {
    await open();
    click("automation-editor-keys-enter-0-1");
    expect(valueOf(text(1))).toBe("\\e[A\\r");
  });

  it("adds a row that follows with a short delay, focused", async () => {
    await open({ kind: "type-keys", chunks: [], timing: "recorded" }, true);
    typeText(text(0), "cd /srv\\r");
    click("automation-editor-keys-add-0");
    expect(document.activeElement).toBe(query(text(1)));
    typeText(text(1), "\\x03");
    expect(keysOf(await editor.save())).toEqual({
      kind: "type-keys",
      timing: "recorded",
      chunks: [
        { data: "cd /srv\r", delayMs: 0 },
        { data: "\x03", delayMs: ADDED_KEYS_DELAY_MS },
      ],
    });
  });

  it("moves and deletes rows with their delays, keeping the focus", async () => {
    await open();
    click("automation-editor-keys-down-0-0");
    expect(valueOf(text(1))).toBe("sudo -v\\r");
    click("automation-editor-keys-delete-0-0");
    expect(document.activeElement).toBe(query(text(0)));
    expect(keysOf(await editor.save()).chunks).toEqual([recorded.chunks[0], recorded.chunks[2]]);
  });

  it("cannot delete the only row", async () => {
    await open({ ...recorded, chunks: [recorded.chunks[0]] });
    expect((query("automation-editor-keys-delete-0-0") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves an edited delay", async () => {
    await open();
    typeText("automation-editor-keys-delay-0-1", "50");
    expect(keysOf(await editor.save()).chunks[1]).toEqual({ data: "\x1b[A", delayMs: 50 });
  });

  it("types what was written, byte for byte", async () => {
    await open({ kind: "type-keys", chunks: [] }, true);
    typeText(text(0), "echo ${HOME} \\\\x41\\t\\n\\e\\x03");
    const saved = await editor.save();
    const sent: string[] = [];
    await runWorkflow(saved.steps, {
      send: (data) => {
        sent.push(data);
        return true;
      },
    } as Parameters<typeof runWorkflow>[1]).done;
    expect(sent).toEqual(["echo ${HOME} \\x41\t\n\x1b\x03"]);
  });
});

describe("validation", () => {
  it.each([
    ["\\q", /Unknown escape/],
    ["\\x4", /Invalid hex escape/],
    ["a\\", /Trailing backslash/],
    ["", /Enter the keys to type/],
  ])("blocks Save on %j and says why under the row", async (value, message) => {
    await open();
    typeText(text(1), value);
    expect(query("automation-editor-keys-error-0-1")).toBeNull();
    leaveField(query(text(1)));
    expect(query("automation-editor-keys-error-0-1")?.textContent).toMatch(message);
    expect(query(text(1))?.getAttribute("aria-invalid")).toBe("true");
    expect(query(text(1))?.getAttribute("aria-describedby")).toContain(
      "automation-step-keys-error-0-1"
    );
    expect(blocked()).toBe(true);
  });

  it("blocks Save on a negative delay while delays count", async () => {
    await open();
    typeText("automation-editor-keys-delay-0-1", "-5");
    leaveField(query("automation-editor-keys-delay-0-1"));
    expect(query("automation-editor-keys-error-0-1")?.textContent).toBe("Delay must be 0 or more.");
    expect(blocked()).toBe(true);
    await pick("automation-editor-step-speed-0", "Instant");
    expect(blocked()).toBe(false);
  });
});

describe("typing speed (#5820)", () => {
  it("is saved with the step and hides the delays that no longer count", async () => {
    await open();
    expect(query("automation-editor-step-speed-0")?.textContent).toContain("As recorded");
    await pick("automation-editor-step-speed-0", "Instant");
    expect(query("automation-editor-keys-delay-0-0")).toBeNull();
    const saved = keysOf(await editor.save());
    expect(saved).toEqual({ ...recorded, timing: "instant" });
  });

  it("takes a delay of its own when fixed", async () => {
    await open();
    await pick("automation-editor-step-speed-0", "Same delay before every key");
    expect((query("automation-editor-step-fixed-delay-0") as HTMLInputElement).placeholder).toBe(
      "40"
    );
    typeText("automation-editor-step-fixed-delay-0", "25");
    expect(keysOf(await editor.save())).toEqual({
      ...recorded,
      timing: "fixed",
      fixedDelayMs: 25,
    });
    typeText("automation-editor-step-fixed-delay-0", "");
    expect(keysOf(await editor.save())).not.toHaveProperty("fixedDelayMs");
  });

  it("does not speak of a recording for hand-written keys", async () => {
    await open({ kind: "type-keys", chunks: [{ data: "a", delayMs: 0 }], timing: "recorded" });
    expect(query("automation-editor-step-speed-0")?.textContent).toContain("With the delays above");
  });
});

describe("a long recording", () => {
  const long: TypeKeysStep = {
    ...recorded,
    chunks: Array.from({ length: 240 }, (_, i) => ({ data: String(i % 10), delayMs: i })),
  };

  it("shows its first rows, and all of them on request", async () => {
    await open(long);
    expect(query(text(SHOWN_KEY_ROWS - 1))).not.toBeNull();
    expect(query(text(SHOWN_KEY_ROWS))).toBeNull();
    const more = query("automation-editor-keys-show-all-0")!;
    expect(more.textContent).toBe("Show all 240 keys");
    click("automation-editor-keys-show-all-0");
    expect(query(text(239))).not.toBeNull();
  });

  it("saves the rows it does not show", async () => {
    await open(long);
    typeText(text(0), "x");
    expect(keysOf(await editor.save()).chunks.slice(1)).toEqual(long.chunks.slice(1));
  });

  it("shows a hidden row that blocks Save", async () => {
    await open({
      ...long,
      chunks: long.chunks.map((c, i) => (i === 100 ? { data: "", delayMs: 0 } : c)),
    });
    click("automation-editor-save");
    await flushAsync();
    expect(document.activeElement).toBe(query(text(100)));
  });
});
