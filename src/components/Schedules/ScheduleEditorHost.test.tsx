/**
 * Editing a schedule keeps everything the user did not change (#5983): the real
 * host, dialog and form, with the stored schedule in the store and the save
 * call captured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { toast } from "@/components/ui";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { flushAsync } from "@/test/flushAsync";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { withTooltip } from "@/test/tooltip";
import type { ScheduleInput, ScheduleView } from "@/types/schedule";
import { ScheduleEditorHost } from "./ScheduleEditorHost";

setupSettingsRegion();
setupConnectionsRegion();

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(() => q(id)!.click());

function setInput(testId: string, value: string) {
  const input = q(testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** A stored schedule with every field set, some of them in unusual shapes. */
const stored: ScheduleView = {
  id: "s1",
  name: "Nightly",
  description: "Checks the web hosts",
  action: { kind: "automation", automationId: "a1", legacySource: "macro" },
  // Not in list order, and one saved connection that no longer exists.
  targets: { kind: "connections", connectionIds: ["c2", "gone", "c1"] },
  // Not in week order.
  rule: { kind: "weekly", days: ["fri", "mon"], time: "03:15" },
  missedRuns: "run-once",
  connectIfNeeded: true,
  enabled: true,
  confirmedAt: "2026-01-01T00:00:00Z",
  createdAt: "c",
  updatedAt: "u",
  running: false,
};

/** The editor-owned part of `view`, as it must be saved when left alone. */
function inputOf(view: ScheduleView): ScheduleInput {
  const { id, name, description, action, targets, rule, missedRuns, connectIfNeeded } = view;
  return { id, name, description, action, targets, rule, missedRuns, connectIfNeeded };
}

describe("ScheduleEditorHost keeps what the user did not change (#5983)", () => {
  let root: Root;
  let container: HTMLDivElement;
  const saveSchedule = vi.fn((_input: ScheduleInput) => Promise.resolve(stored));

  beforeEach(() => {
    saveSchedule.mockClear();
    useAppStore.setState(useAppStore.getInitialState());
    seedConnectionsRegion({
      connections: ["c1", "c2", "c3"].map((id) => ({
        id,
        name: id,
        config: {} as never,
        folderId: null,
      })),
    });
    useAppStore.setState({
      saveSchedule,
      schedules: [stored],
      automations: ["a1", "a2"].map((id) => ({
        id,
        name: id,
        tags: [],
        steps: [],
        triggers: [],
        createdAt: "",
        updatedAt: "",
      })),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function open() {
    await act(async () => root.render(withTooltip(<ScheduleEditorHost />)));
    act(() => useAppStore.getState().openScheduleEditor({ scheduleId: "s1" }));
    await flushAsync();
  }
  async function save(): Promise<ScheduleInput> {
    await act(async () => q("schedule-editor-save")!.click());
    expect(saveSchedule).toHaveBeenCalledTimes(1);
    return saveSchedule.mock.calls[0][0];
  }

  it("shows the stored description and option", async () => {
    await open();
    expect((q("schedule-editor-description") as HTMLInputElement).value).toBe(stored.description);
    expect(q("schedule-editor-closed-connect")!.getAttribute("aria-checked")).toBe("true");
  });

  it("a rename saves every other field exactly as stored", async () => {
    await open();
    setInput("schedule-editor-name", "Renamed");
    expect(await save()).toEqual({ ...inputOf(stored), name: "Renamed" });
  });

  it("saving without a change saves the stored schedule", async () => {
    await open();
    expect(await save()).toEqual(inputOf(stored));
  });

  it("a changed description or option is saved, and only that changes", async () => {
    await open();
    setInput("schedule-editor-description", "");
    click("schedule-editor-closed-skip");
    const saved = await save();
    expect(saved.description).toBeUndefined();
    expect(saved.connectIfNeeded).not.toBe(true);
    expect(saved).toMatchObject({
      action: stored.action,
      targets: stored.targets,
      rule: stored.rule,
      missedRuns: "run-once",
    });
  });

  it("an added target keeps the others, also one whose connection is gone", async () => {
    await open();
    click("schedule-editor-connection-c3");
    expect((await save()).targets).toEqual({
      kind: "connections",
      connectionIds: ["c2", "gone", "c1", "c3"],
    });
  });

  it("a changed time saves the new rule and keeps the rest", async () => {
    await open();
    setInput("schedule-editor-time", "04:00");
    expect(await save()).toEqual({
      ...inputOf(stored),
      rule: { kind: "weekly", days: ["mon", "fri"], time: "04:00" },
    });
  });

  it("keeps a broadcast group that no longer exists", async () => {
    seedSettings({ broadcastGroups: [] });
    const targets = { kind: "broadcast-group" as const, groupId: "gone" };
    useAppStore.setState({ schedules: [{ ...stored, targets }] });
    await open();
    setInput("schedule-editor-name", "Renamed");
    expect((await save()).targets).toEqual(targets);
  });

  describe("after Save: is it on? (A-044)", () => {
    async function saveAs(view: Partial<ScheduleView>) {
      saveSchedule.mockResolvedValueOnce({ ...stored, ...view });
      await open();
      await act(async () => q("schedule-editor-save")!.click());
      await flushAsync();
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    }

    it("says that it was saved switched off, not inside the closing editor", async () => {
      const info = vi.spyOn(toast, "info");
      await saveAs({ enabled: false });
      expect(info).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith("Saved “Nightly”, switched off", {
        description: "Switch it on in the Schedules list.",
      });
      // The editor and its status line are gone by then.
      expect(q("schedule-editor-dialog")).toBeNull();
      info.mockRestore();
    });

    it("says nothing of it when it stays on, and shows the row", async () => {
      const info = vi.spyOn(toast, "info");
      await saveAs({});
      expect(info).not.toHaveBeenCalled();
      expect(useAutomationSections.getState()).toMatchObject({
        schedulesOpen: true,
        savedSchedule: { id: "s1" },
      });
      info.mockRestore();
    });
  });

  it("does not revert a change another window saved meanwhile", async () => {
    await open();
    act(() =>
      useAppStore.setState({
        schedules: [
          {
            ...stored,
            missedRuns: "skip",
            targets: { kind: "connections", connectionIds: ["c3"] },
          },
        ],
      })
    );
    setInput("schedule-editor-name", "Renamed");
    expect(await save()).toEqual({
      ...inputOf(stored),
      name: "Renamed",
      missedRuns: "skip",
      targets: { kind: "connections", connectionIds: ["c3"] },
    });
  });
});
