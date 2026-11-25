/**
 * "Record steps" (#5818, slice 8): the editor hides while the user types in the
 * terminal they picked, keeps its draft, and comes back with the recording as a
 * step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import {
  automationWith,
  chooseFrom,
  click,
  mountEditor,
  query,
  typeText,
  valueOf,
  type EditorHarness,
} from "@/test/automationEditorHarness";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { seedLayoutState } from "@/test/layoutState";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { Automation } from "@/types/generated/Automation";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { useAutomationEditor } from "./automationEditorStore";

setupConnectionsRegion();
setupSettingsRegion();

const tab = (id: string, title: string): TerminalTab => ({
  id,
  sessionId: `sess-${id}`,
  title,
  connectionType: "local",
  contentType: "terminal",
  config: { type: "local", config: {} },
  panelId: "leaf",
  isActive: id === "a",
});
function seedTabs(tabs: TerminalTab[]): void {
  const leaf: LeafPanel = {
    type: "leaf",
    id: "leaf",
    tabs,
    activeTabId: tabs[0]?.id ?? null,
  };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf" });
}

const store = () => useAppStore.getState();
const stored = automationWith([
  { kind: "send-command", command: "make" },
  { kind: "wait", delayMs: 500 },
]);

let editor: EditorHarness;
async function open(automation: Automation = stored, isNew = false): Promise<void> {
  editor = await mountEditor(automation, { isNew });
}
/** Type into the recorded terminal. */
const type = (...keys: Array<[string, string?]>) =>
  act(() => {
    for (const [data, screen = "$ "] of keys) {
      store().recordInput(store().recording!.tabId, data, (then) => then(screen));
    }
  });
async function stop(): Promise<void> {
  act(() => store().stopRecording());
  await flushAsync();
}
const kinds = () =>
  Array.from(document.querySelectorAll("[data-kind]"), (el) => (el as HTMLElement).dataset.kind);

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  seedTabs([tab("a", "prod-web"), tab("b", "db-1")]);
});
afterEach(() => {
  if (store().recording) act(() => store().stopRecording());
  editor.unmount();
});

describe("Record steps", () => {
  it("lets the user pick the terminal, the active one first, then hides the editor", async () => {
    await open();
    typeText("automation-editor-name", "Deploy everything");
    await chooseFrom("automation-editor-record", "automation-editor-record-in-b");
    expect(store().recording).toMatchObject({ tabId: "b", intoEditor: "Deploy everything" });
    expect(query("automation-editor-dialog")).toBeNull();
  });

  it("with one terminal records there at once", async () => {
    seedTabs([tab("a", "prod-web")]);
    await open();
    click("automation-editor-record");
    expect(store().recording?.tabId).toBe("a");
  });

  it("without a terminal opens one and records there (A-034)", async () => {
    seedTabs([]);
    await open();
    expect(query("automation-editor-record")?.textContent).toBe("Record steps in a new terminal");
    const addLocalShellTab = vi.fn(() => {
      seedTabs([tab("a", "bash")]);
      return "a";
    });
    act(() => useAppStore.setState({ addLocalShellTab }));
    click("automation-editor-record");
    await flushAsync();
    expect(addLocalShellTab).toHaveBeenCalledTimes(1);
    expect(store().recording).toMatchObject({ tabId: "a", intoEditor: stored.name });
  });

  it("a canceled recording comes back with the draft and nothing else (A-010)", async () => {
    await open();
    typeText("automation-editor-name", "Renamed");
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    type(["oops\r"]);
    act(() => store().cancelRecording());
    await flushAsync();
    expect(valueOf("automation-editor-name")).toBe("Renamed");
    expect(kinds()).toEqual(["send-command", "wait"]);
    expect(query("automation-editor-recorded")).toBeNull();
    expect(store().recordedTake).toBeNull();
  });

  it("the footer names the terminal it would run in (A-021)", async () => {
    await open();
    expect(query("automation-editor-save-run")?.textContent).toBe("Save and run in prod-web");
  });

  it("comes back with the draft as it was and the recording as the last step", async () => {
    await open();
    typeText("automation-editor-name", "Deploy everything");
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    type(["git pull"], ["\r"]);
    await stop();
    expect(valueOf("automation-editor-name")).toBe("Deploy everything");
    expect(kinds()).toEqual(["send-command", "wait", "type-keys"]);
    expect(query("automation-editor-step-summary-2")?.textContent).toBe("git pull⏎Recorded");
    expect(query("automation-editor-recorded")?.textContent).toMatch(
      /^Recorded in prod-web, \d+\.\d s\.$/
    );
    expect(document.activeElement).toBe(query("automation-editor-record"));
    expect((await editor.save()).steps).toEqual([
      ...stored.steps,
      {
        kind: "type-keys",
        chunks: [
          { data: "git pull", delayMs: 0 },
          { data: "\r", delayMs: expect.any(Number) },
        ],
        timing: "recorded",
        recorded: true,
      },
    ]);
  });

  it("inserts after the step that was worked on last", async () => {
    await open();
    act(() => query("automation-editor-step-toggle-0")!.focus());
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    type(["x"]);
    await stop();
    expect(kinds()).toEqual(["send-command", "type-keys", "wait"]);
  });

  it("replaces the blank row of a new typed automation", async () => {
    await open(automationWith([{ kind: "type-keys", chunks: [] }], { name: "" }), true);
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    expect(store().recording?.intoEditor).toBe("");
    type(["ls\r"]);
    await stop();
    expect(kinds()).toEqual(["type-keys"]);
    expect(query("automation-editor-step-summary-0")?.textContent).toContain("ls⏎");
  });

  it("inserts nothing when nothing was typed, and says so", async () => {
    await open();
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    await stop();
    expect(kinds()).toEqual(["send-command", "wait"]);
    expect(query("automation-editor-recorded")?.textContent).toBe("Nothing was typed in prod-web.");
  });

  it("comes back by itself when the terminal goes, with what was typed", async () => {
    await open();
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    type(["ls\r"]);
    act(() => store().stopRecording("tab-gone"));
    await flushAsync();
    expect(kinds()).toContain("type-keys");
    expect(query("automation-editor-recorded")?.textContent).toContain(
      "The terminal was closed or moved"
    );
  });

  it("leaves out what was typed at a password prompt until it is asked for", async () => {
    await open();
    await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
    type(["sudo -v\r"], ["pw", "Password: "], ["\r", "Password: "], ["ls\r"]);
    await stop();
    expect(query("automation-editor-recorded")?.textContent).toContain(
      "What you typed at “Password:” was left out: the automation waits for you there."
    );
    expect(kinds()).toEqual(["send-command", "wait", "type-keys", "wait-for-user", "type-keys"]);
    const typed = (a: Automation) =>
      a.steps.flatMap((s) => (s.kind === "type-keys" ? s.chunks.map((c) => c.data) : []));
    expect(typed(await editor.save())).toEqual(["sudo -v\r", "ls\r"]);
    click("automation-editor-recorded-keep-secrets");
    expect(query("automation-editor-recorded-keep-secrets")).toBeNull();
    expect(typed(await editor.save())).toEqual(["sudo -v\r", "pw", "\r", "ls\r"]);
    expect(kinds()).toEqual(["send-command", "wait", "type-keys"]);
  });
});

it("the editor does not give way to another automation while it waits", async () => {
  await open();
  const info = vi.spyOn(toast, "info").mockReturnValue("t");
  useAutomationEditor.setState({ editing: { automation: stored, isNew: false } });
  await chooseFrom("automation-editor-record", "automation-editor-record-in-a");
  useAutomationEditor.getState().open(automationWith([], { id: "other" }), false);
  expect(useAutomationEditor.getState().editing?.automation.id).toBe(stored.id);
  expect(info).toHaveBeenCalledWith("Stop the recording into the open automation first");
  useAutomationEditor.getState().close();
  info.mockRestore();
});
