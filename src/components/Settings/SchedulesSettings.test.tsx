import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { checkA11y } from "@/test/axe";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { withTooltip } from "@/test/tooltip";
import type { ScheduleView } from "@/types/schedule";
import { SchedulesSettings } from "./SchedulesSettings";

/**
 * Settings → Schedules (#4623): the always-available schedules panel, usable
 * with experimental features (and so the Workflows sidebar) off. It lists the
 * schedules, pauses/resumes them (per schedule and globally) and deletes them;
 * creating and editing stay in the Workflows sidebar.
 */

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

setupConnectionsRegion();

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = () => act(async () => await Promise.resolve());

function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "s1",
    name: "Nightly backup",
    action: { kind: "macro", macroId: "m-1" },
    targets: { kind: "connections", connectionIds: ["c1"] },
    rule: { kind: "interval", everyMinutes: 30 },
    missedRuns: "skip",
    enabled: true,
    confirmedAt: "2026-10-01T00:00:00Z",
    running: false,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

let setScheduleEnabled: ReturnType<typeof vi.fn>;
let setSchedulesPaused: ReturnType<typeof vi.fn>;
let deleteSchedule: ReturnType<typeof vi.fn>;
let openScheduleEditor: ReturnType<typeof vi.fn>;

async function render(schedules: ScheduleView[], paused = false) {
  act(() => {
    useAppStore.setState({
      schedules,
      schedulesPaused: paused,
      setScheduleEnabled,
      setSchedulesPaused,
      deleteSchedule,
      openScheduleEditor,
    } as never);
  });
  await act(async () => root.render(withTooltip(<SchedulesSettings />)));
  await flushAsync();
}

describe("SchedulesSettings (#4623)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setScheduleEnabled = vi.fn(() => Promise.resolve());
    setSchedulesPaused = vi.fn(() => Promise.resolve());
    deleteSchedule = vi.fn(() => Promise.resolve());
    openScheduleEditor = vi.fn();
    seedConnectionsRegion({
      connections: [{ id: "c1", name: "db-1", config: {} as never, folderId: null }],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("shows an empty state without create/edit actions", async () => {
    await render([]);
    expect(query("schedules-settings")).not.toBeNull();
    expect(query("schedules-empty")).not.toBeNull();
    expect(query("schedules-new-btn")).toBeNull();
  });

  it("lists every schedule with its rule and targets, and offers no editing", async () => {
    await render([view(), view({ id: "s2", name: "Health", enabled: false })]);
    expect(query("schedule-item-s1")).not.toBeNull();
    expect(query("schedule-item-s2")).not.toBeNull();
    expect(query("schedule-summary-s1")!.textContent).toContain("Every 30 minutes");
    expect(query("schedule-summary-s1")!.textContent).toContain("db-1");
    expect(query("schedule-status-s2")!.textContent).toBe("Disabled");
    expect(query("schedule-edit-s1")).toBeNull();
    expect(query("schedules-new-btn")).toBeNull();
  });

  it("pauses (disables) and resumes (re-enables) a single schedule", async () => {
    await render([view()]);
    await act(async () => query("schedule-enable-s1")!.click());
    expect(setScheduleEnabled).toHaveBeenLastCalledWith("s1", false, false);

    await render([view({ enabled: false })]);
    await act(async () => query("schedule-enable-s1")!.click());
    expect(setScheduleEnabled).toHaveBeenLastCalledWith("s1", true, false);
  });

  it("pauses and resumes all schedules with the global switch", async () => {
    await render([view()]);
    await act(async () => query("schedules-pause-toggle")!.click());
    expect(setSchedulesPaused).toHaveBeenLastCalledWith(true);

    await render([view()], true);
    expect(query("schedule-status-s1")!.textContent).toBe("Paused");
    await act(async () => query("schedules-pause-toggle")!.click());
    expect(setSchedulesPaused).toHaveBeenLastCalledWith(false);
  });

  it("deletes a schedule after confirmation", async () => {
    await render([view()]);
    act(() => query("schedule-delete-s1")!.click());
    expect(deleteSchedule).not.toHaveBeenCalled();
    await act(async () => query("confirm-delete-confirm")!.click());
    await flush();
    expect(deleteSchedule).toHaveBeenCalledWith("s1");
  });

  it("has no a11y violations", async () => {
    await render([view(), view({ id: "s2", name: "Health", enabled: false })]);
    expect(await checkA11y()).toHaveNoViolations();
  });
});
