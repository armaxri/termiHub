import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { withTooltip } from "@/test/tooltip";
import type { ScheduleView } from "@/types/schedule";
import { SchedulesSection } from "./SchedulesSection";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

setupConnectionsRegion();

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const flush = () => act(async () => await Promise.resolve());

function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "s1",
    name: "Health",
    action: { kind: "workflow", workflowId: "wf-1" },
    targets: { kind: "connections", connectionIds: ["c1", "c2"] },
    rule: { kind: "interval", everyMinutes: 15 },
    missedRuns: "skip",
    enabled: false,
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

function render(schedules: ScheduleView[], paused = false) {
  useAppStore.setState({
    schedules,
    schedulesPaused: paused,
    workflows: [
      {
        id: "wf-1",
        name: "Uptime",
        tags: [],
        steps: [],
        triggers: [],
        createdAt: "",
        updatedAt: "",
      },
    ],
    setScheduleEnabled,
    setSchedulesPaused,
    deleteSchedule,
    openScheduleEditor,
  } as never);
  act(() => root.render(withTooltip(<SchedulesSection />)));
}

describe("SchedulesSection (PROD-043)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setScheduleEnabled = vi.fn(() => Promise.resolve());
    setSchedulesPaused = vi.fn(() => Promise.resolve());
    deleteSchedule = vi.fn(() => Promise.resolve());
    openScheduleEditor = vi.fn();
    seedConnectionsRegion({
      connections: [
        { id: "c1", name: "web-1", config: {} as never, folderId: null },
        { id: "c2", name: "web-2", config: {} as never, folderId: null },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("shows an empty state and opens the editor for a new schedule", () => {
    render([]);
    expect(query("schedules-empty")).not.toBeNull();
    act(() => query("schedules-new-btn")!.click());
    expect(openScheduleEditor).toHaveBeenCalledWith();
  });

  it("summarises the rule, action and target hosts", () => {
    render([view({ enabled: true, nextRunAt: new Date().toISOString() })]);
    expect(query("schedule-summary-s1")!.textContent).toBe(
      'Every 15 minutes · workflow "Uptime" on web-1, web-2'
    );
    expect(query("schedule-status-s1")!.textContent).toMatch(/^Next: today/);
  });

  it("asks for confirmation listing the hosts before the first enable", async () => {
    render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    expect(setScheduleEnabled).not.toHaveBeenCalled();
    const hosts = query("schedule-confirm-hosts")!;
    expect(hosts.textContent).toContain("web-1");
    expect(hosts.textContent).toContain("web-2");
    await act(async () => query("schedule-enable-confirm-confirm")!.click());
    await flush();
    expect(setScheduleEnabled).toHaveBeenCalledWith("s1", true, true);
  });

  it("cancelling the confirmation leaves the schedule disabled", () => {
    render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    act(() => query("schedule-enable-confirm-cancel")!.click());
    expect(setScheduleEnabled).not.toHaveBeenCalled();
  });

  it("toggles an already-confirmed schedule without asking again", async () => {
    render([view({ confirmedAt: "2026-09-26T00:00:00Z" })]);
    await act(async () => query("schedule-enable-s1")!.click());
    expect(query("schedule-confirm-hosts")).toBeNull();
    expect(setScheduleEnabled).toHaveBeenCalledWith("s1", true, false);
  });

  it("the global switch pauses all schedules", async () => {
    render([view({ enabled: true, confirmedAt: "x" })]);
    await act(async () => query("schedules-pause-toggle")!.click());
    expect(setSchedulesPaused).toHaveBeenCalledWith(true);
  });

  it("shows paused, running and disabled states and the last result", () => {
    render(
      [
        view({ id: "a", enabled: true, confirmedAt: "x" }),
        view({ id: "b", enabled: true, confirmedAt: "x", running: true }),
        view({
          id: "c",
          lastResult: {
            at: new Date().toISOString(),
            outcome: "skipped",
            message: "None of the target connections is connected",
          },
        }),
      ],
      true
    );
    expect(query("schedule-status-a")!.textContent).toBe("Paused");
    expect(query("schedule-status-b")!.textContent).toBe("Running now");
    expect(query("schedule-status-c")!.textContent).toBe("Disabled");
    expect(query("schedule-last-c")!.textContent).toContain(
      "skipped — None of the target connections is connected"
    );
  });

  it("edits and deletes a schedule", async () => {
    render([view()]);
    act(() => query("schedule-edit-s1")!.click());
    expect(openScheduleEditor).toHaveBeenCalledWith({ scheduleId: "s1" });
    act(() => query("schedule-delete-s1")!.click());
    await act(async () => query("confirm-delete-confirm")!.click());
    await flush();
    expect(deleteSchedule).toHaveBeenCalledWith("s1");
  });
});
