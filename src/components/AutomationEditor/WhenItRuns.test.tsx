/**
 * "When it runs" (#5818): triggers with their settings right under them
 * (R-158), the Armed switch, and the schedules that run the automation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { useAppStore } from "@/store/appStore";
import {
  automationWith,
  chooseFrom,
  click,
  mountEditor,
  pick,
  query,
  typeText,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { installConnectionIdChangesHarness } from "@/test/connectionIdChangesHarness";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { leaveField } from "@/test/leaveField";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { AutomationTrigger } from "@/types/generated/AutomationTrigger";
import type { ScheduleView } from "@/types/schedule";

setupConnectionsRegion();
setupSettingsRegion();

const openScheduleEditor = vi.fn();
const realOpenScheduleEditor = useAppStore.getState().openScheduleEditor;

const schedule = {
  id: "s-1",
  name: "Nightly",
  action: { kind: "automation", automationId: "a-1" },
  targets: { kind: "connections", connectionIds: ["conn-1"] },
  rule: { kind: "daily", time: "09:10" },
  missedRuns: "skip",
  enabled: false,
  running: false,
  connectIfNeeded: false,
} as unknown as ScheduleView;

let editor: EditorHarness;
async function open(
  triggers: AutomationTrigger[] = [],
  { isNew = false, off = false } = {}
): Promise<void> {
  const automation = automationWith([{ kind: "wait", delayMs: 1 }], { triggers });
  if (off) automation.triggersEnabled = false;
  editor = await mountEditor(automation, { isNew });
  if (query("automation-editor-when") === null) click("automation-editor-when-toggle");
  await flushAsync();
}
const add = (kind: string) =>
  chooseFrom("automation-editor-add-trigger", `automation-editor-add-trigger-${kind}`);
const savedTriggers = async () => (await editor.save()).triggers;

beforeEach(() => {
  openScheduleEditor.mockReset();
  useAppStore.setState({ automations: [], schedules: [], openScheduleEditor });
  seedConnectionsRegion({
    connections: [
      { id: "conn-1", name: "prod-web-1", config: {} as never, folderId: null },
      { id: "conn-2", name: "prod-web-2", config: {} as never, folderId: null },
    ],
  });
});
afterEach(() => {
  editor.unmount();
  useAppStore.setState({ openScheduleEditor: realOpenScheduleEditor });
});

describe("triggers", () => {
  it("says that it always runs by hand", async () => {
    await open();
    expect(query("automation-editor-when-manual")?.textContent).toContain("When you run it");
    expect(query("automation-editor-triggers")).toBeNull();
  });

  it("adds a hotkey, focused", async () => {
    await open();
    await add("hotkey");
    expect(document.activeElement).toBe(query("automation-trigger-binding-0"));
    typeText("automation-trigger-binding-0", "Ctrl+Alt+H");
    expect(await savedTriggers()).toEqual([{ kind: "hotkey", binding: "Ctrl+Alt+H" }]);
  });

  it("adds an on-connect trigger and warns while it has no connection", async () => {
    await open();
    await add("on-connect");
    expect(query("automation-trigger-connection-0-none")).not.toBeNull();
    click("automation-trigger-connection-0-conn-2");
    expect(query("automation-trigger-connection-0-none")).toBeNull();
    expect(await savedTriggers()).toEqual([{ kind: "on-connect", connectionIds: ["conn-2"] }]);
  });

  it("adds an on-disconnect trigger with its cause", async () => {
    await open();
    await add("on-disconnect");
    click("automation-trigger-connection-0-conn-1");
    await pick("automation-trigger-when-0", "Any disconnect");
    expect(await savedTriggers()).toEqual([
      { kind: "on-disconnect", connectionIds: ["conn-1"], when: "any" },
    ]);
  });

  it("edits an on-output-match pattern, regex flag and limits, under their own card", async () => {
    await open();
    await add("on-output-match");
    const card = query("automation-editor-trigger-0")!;
    expect(card.contains(query("automation-trigger-pattern-0"))).toBe(true);
    click("automation-trigger-connection-0-conn-1");
    typeText("automation-trigger-pattern-0", "ERROR \\d+");
    click("automation-trigger-regex-0");
    typeText("automation-trigger-cooldown-0", "30");
    typeText("automation-trigger-max-fires-0", "2");
    expect(await savedTriggers()).toEqual([
      {
        kind: "on-output-match",
        connectionIds: ["conn-1"],
        pattern: "ERROR \\d+",
        isRegex: true,
        cooldownMs: 30_000,
        maxFiresPerSession: 2,
      },
    ]);
    click("automation-trigger-regex-0");
    typeText("automation-trigger-cooldown-0", "");
    typeText("automation-trigger-max-fires-0", "");
    expect(await savedTriggers()).toEqual([
      { kind: "on-output-match", connectionIds: ["conn-1"], pattern: "ERROR \\d+" },
    ]);
  });

  it("names a bad pattern once it was edited and left, not before (#5917)", async () => {
    await open();
    await add("on-output-match");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    click("automation-trigger-regex-0");
    typeText("automation-trigger-pattern-0", "(a+)+");
    leaveField(query("automation-trigger-pattern-0"));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(query("automation-editor-save")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps several triggers of one kind apart", async () => {
    const triggers: AutomationTrigger[] = [
      { kind: "on-disconnect", connectionIds: ["conn-1"] },
      { kind: "on-disconnect", connectionIds: ["conn-2"], when: "any" },
    ];
    await open(triggers);
    click("automation-trigger-connection-0-conn-2");
    expect(await savedTriggers()).toEqual([
      { kind: "on-disconnect", connectionIds: ["conn-1", "conn-2"] },
      triggers[1],
    ]);
  });

  it("removes a trigger and keeps the focus in the section", async () => {
    await open([{ kind: "hotkey", binding: "F8" }]);
    click("automation-editor-trigger-remove-0");
    expect(document.activeElement).toBe(query("automation-editor-add-trigger"));
    expect(await savedTriggers()).toEqual([]);
  });

  it("follows a renamed connection without counting it as an edit (#3603)", async () => {
    const events = installConnectionIdChangesHarness();
    await open([{ kind: "on-connect", connectionIds: ["conn-1", "x"] }]);
    events.emit([{ oldId: "conn-1", newId: "Prod/conn-1" }]);
    click("automation-editor-save");
    await flushAsync();
    expect(editor.onSave.mock.calls[0][0].automation).toBeNull();
    typeText("automation-editor-name", "x");
    expect(await savedTriggers()).toEqual([
      { kind: "on-connect", connectionIds: ["Prod/conn-1", "x"] },
    ]);
  });
});

describe("the Armed switch", () => {
  it("shows with any trigger, a hotkey too (#5818, slice 11)", async () => {
    await open();
    expect(query("automation-editor-armed")).toBeNull();
    await add("hotkey");
    expect(query("automation-editor-armed")?.getAttribute("aria-checked")).toBe("true");
  });

  it("says that off covers a hotkey", async () => {
    await open([{ kind: "hotkey", binding: "F8" }], { off: true });
    expect(query("automation-editor-when")?.textContent).toContain(
      "Off: only a schedule or you can start it."
    );
  });

  it("is stored only while off", async () => {
    await open([{ kind: "on-connect", connectionIds: ["conn-1"] }]);
    click("automation-editor-armed");
    expect((await editor.save()).triggersEnabled).toBe(false);
  });

  it("arms again", async () => {
    await open([{ kind: "on-connect", connectionIds: ["conn-1"] }], { off: true });
    click("automation-editor-armed");
    expect(await editor.save()).not.toHaveProperty("triggersEnabled");
  });
});

describe("schedules", () => {
  it("are linked by what they do, with their own editor", async () => {
    useAppStore.setState({ schedules: [schedule] });
    await open();
    expect(query("automation-editor-schedule-s-1")?.textContent).toMatch(
      /Nightly: .*09:10.* on prod-web-1 · Disabled/
    );
    click("automation-editor-schedule-edit-s-1");
    expect(openScheduleEditor).toHaveBeenCalledWith({ scheduleId: "s-1" });
  });

  it("open the section and count in its summary", async () => {
    useAppStore.setState({ schedules: [schedule] });
    await open();
    expect(query("automation-editor-when-toggle")?.textContent).toContain("1 schedule");
  });

  it("On a schedule… opens the schedule editor for a stored automation", async () => {
    await open();
    await chooseFrom("automation-editor-add-trigger", "automation-editor-add-schedule");
    expect(openScheduleEditor).toHaveBeenCalledWith({
      action: { kind: "automation", automationId: "a-1" },
    });
  });

  it("wait for the save of a new automation, and can be taken back", async () => {
    await open([], { isNew: true });
    await chooseFrom("automation-editor-add-trigger", "automation-editor-add-schedule");
    expect(openScheduleEditor).not.toHaveBeenCalled();
    expect(query("automation-editor-schedule-pending")).not.toBeNull();
    click("automation-editor-schedule-pending-remove");
    expect(query("automation-editor-schedule-pending")).toBeNull();
    await chooseFrom("automation-editor-add-trigger", "automation-editor-add-schedule");
    await editor.save();
    expect(editor.onSave.mock.calls[0][0].schedule).toBe(true);
  });
});
