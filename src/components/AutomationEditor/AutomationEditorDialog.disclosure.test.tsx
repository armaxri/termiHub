/**
 * Progressive disclosure and layout of the automation editor (#5818, R-076):
 * who only records and replays keys sees no triggers, values or step internals
 * unless they ask; one scroll container, one line per collapsed step (#5637).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { useAppStore } from "@/store/appStore";
import {
  automationWith,
  chooseFrom,
  chooseStep,
  click,
  mountEditor,
  query,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { Automation } from "@/types/generated/Automation";

setupConnectionsRegion();
setupSettingsRegion();

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "AutomationEditor.css"),
  "utf8"
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

const keys = automationWith([
  {
    kind: "type-keys",
    chunks: [
      { data: "ls", delayMs: 0 },
      { data: "\r", delayMs: 90 },
    ],
    timing: "recorded",
    recorded: true,
  },
]);
const steps = automationWith([
  { kind: "send-command", command: "make deploy", continueOnError: true },
  { kind: "wait", delayMs: 500 },
  { kind: "wait-for-output", pattern: "READY" },
]);

let editor: EditorHarness;
const open = async (automation: Automation, isNew = false) => {
  editor = await mountEditor(automation, { isNew });
};
const text = () => query("automation-editor-form")!.textContent ?? "";
const expandedOf = (id: string) => query(id)?.getAttribute("aria-expanded");

beforeEach(() => useAppStore.setState({ automations: [], schedules: [] }));
afterEach(() => editor.unmount());

describe("an automation that only types recorded keys", () => {
  it("shows a name, a description and one line for the keys", async () => {
    await open(keys);
    expect(query("automation-editor-step-summary-0")?.textContent).toBe("ls⏎Recorded");
    expect(query("automation-editor-step-body-0")).toBeNull();
    expect(expandedOf("automation-editor-when-toggle")).toBe("false");
    expect(query("automation-editor-when-toggle")?.textContent).toContain("Only when you run it");
    expect(expandedOf("automation-editor-tags-toggle")).toBe("false");
    // Keys are typed exactly, so there is nothing to fill a value into.
    expect(query("automation-editor-values-toggle")).toBeNull();
    for (const word of ["Trigger", "trigger", "Parameter", "fails", "Retry", "Armed", "ms"]) {
      expect(text()).not.toContain(word);
    }
    expect(document.querySelectorAll("input")).toHaveLength(2);
  });

  it("a new one shows its keys to type, nothing else", async () => {
    await open(automationWith([{ kind: "type-keys", chunks: [] }], { name: "" }), true);
    expect(query("automation-editor-keys-text-0-0")).not.toBeNull();
    expect(query("automation-editor-values-toggle")).toBeNull();
    expect(query("automation-editor-step-policy-0")).toBeNull();
  });
});

describe("what a power user asks for", () => {
  it("offers the values to ask for once a step can use them", async () => {
    await open(keys);
    await chooseFrom("automation-editor-add-step", "automation-editor-add-step-send-command");
    expect(expandedOf("automation-editor-values-toggle")).toBe("false");
    click("automation-editor-values-toggle");
    expect(query("automation-params-add")).not.toBeNull();
  });

  it("names stored values in the closed heading, also of keys-only automations (A-024)", async () => {
    await open({
      ...keys,
      parameters: [
        { name: "host", type: "string" },
        { name: "env", label: "Environment", type: "string" },
      ],
    });
    expect(expandedOf("automation-editor-values-toggle")).toBe("false");
    expect(query("automation-editor-values-toggle")?.textContent).toContain("host, Environment");
    click("automation-editor-values-toggle");
    expect(query("automation-param-name-0")).not.toBeNull();
  });

  it("names the triggers in its heading, and keeps the steps first (editor-6)", async () => {
    await open({ ...keys, triggers: [{ kind: "hotkey", binding: "Ctrl+Alt+D" }] });
    const toggle = query("automation-editor-when-toggle")!;
    expect(toggle.textContent).toContain("Hotkey");
    // One order for every automation: the steps do not move with its triggers.
    expect(
      query("automation-editor-steps")!.compareDocumentPosition(toggle) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    click("automation-editor-when-toggle");
    expect(query("automation-trigger-binding-0")).not.toBeNull();
  });

  it("stays where it is while a trigger is added", async () => {
    await open(steps);
    click("automation-editor-when-toggle");
    await chooseFrom("automation-editor-add-trigger", "automation-editor-add-trigger-hotkey");
    expect(
      query("automation-editor-steps")!.compareDocumentPosition(
        query("automation-editor-when-toggle")!
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows a step's failure options once set or asked for", async () => {
    await open(steps);
    click("automation-editor-steps-toggle-all");
    expect(query("automation-editor-step-policy-0")).not.toBeNull();
    expect(query("automation-editor-step-policy-1")).toBeNull();
    await chooseStep("1", "failure-menu");
    expect(document.activeElement).toBe(query("automation-editor-step-on-failure-1"));
  });

  it("goes to the typing speed from the step's menu, also of a closed step", async () => {
    await open(keys);
    await chooseStep("0", "speed-menu");
    expect(document.activeElement).toBe(query("automation-editor-step-speed-0"));
  });
});

describe("layout (#5637, R-076)", () => {
  it("opens stored steps as one line each, and expands them all at once", async () => {
    await open(steps);
    const all = () => query("automation-editor-steps-toggle-all")!;
    expect(query("automation-editor-step-summary-0")?.textContent).toContain("make deploy");
    expect(query("automation-editor-step-summary-0")?.textContent).toContain(
      "Continues if it fails"
    );
    expect(query("automation-editor-step-command-0")).toBeNull();
    expect(all().textContent).toBe("Expand all");
    click("automation-editor-steps-toggle-all");
    for (const i of [0, 1, 2]) expect(query(`automation-editor-step-body-${i}`)).not.toBeNull();
    expect(all().textContent).toBe("Collapse all");
    click("automation-editor-steps-toggle-all");
    expect(query("automation-editor-step-body-1")).toBeNull();
  });

  it("puts the steps right after Name and Description", async () => {
    await open(steps);
    const order = [
      "automation-editor-name",
      "automation-editor-description",
      "automation-editor-steps",
      "automation-editor-when-toggle",
      "automation-editor-values-toggle",
      "automation-editor-tags-toggle",
    ].map((id) => query(id)!);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    expect(rule(".automation-editor__head")).toMatch(/grid-template-columns/);
  });

  it("has no inner scroll box: steps and trigger connections flow in the body", () => {
    for (const selector of [".automation-steps__list", ".automation-triggers__connections"]) {
      const decl = rule(selector);
      expect(decl).not.toMatch(/overflow/);
      expect(decl).not.toMatch(/max-height/);
    }
  });

  it("sets step type titles in the UI font, semibold", () => {
    const decl = rule(".automation-step__kind");
    expect(decl).not.toMatch(/font-mono/);
    expect(decl).toMatch(/font-weight:\s*var\(--font-weight-semibold\)/);
  });
});
