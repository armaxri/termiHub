import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
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

async function render(schedules: ScheduleView[], paused = false) {
  // Wrapped in act: the second render in a test updates an already-mounted tree.
  act(() => {
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
  });
  await act(async () => root.render(withTooltip(<SchedulesSection />)));
  await flushAsync();
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

  it("shows an empty state and opens the editor for a new schedule", async () => {
    await render([]);
    expect(query("schedules-empty")).not.toBeNull();
    act(() => query("schedules-new-btn")!.click());
    expect(openScheduleEditor).toHaveBeenCalledWith();
  });

  it("summarises the rule, action and target hosts", async () => {
    await render([view({ enabled: true, nextRunAt: new Date().toISOString() })]);
    expect(query("schedule-summary-s1")!.textContent).toBe(
      'Every 15 minutes · workflow "Uptime" on web-1, web-2'
    );
    expect(query("schedule-status-s1")!.textContent).toMatch(/^Next: today/);
  });

  it("asks for confirmation listing the hosts before the first enable", async () => {
    await render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    expect(setScheduleEnabled).not.toHaveBeenCalled();
    const hosts = query("schedule-confirm-hosts")!;
    expect(hosts.textContent).toContain("web-1");
    expect(hosts.textContent).toContain("web-2");
    await act(async () => query("schedule-enable-confirm-confirm")!.click());
    await flush();
    expect(setScheduleEnabled).toHaveBeenCalledWith("s1", true, true);
  });

  it("the confirmation says a connecting schedule also connects the hosts (#3527)", async () => {
    await render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    expect(query("schedule-confirm-connects")).toBeNull();
    act(() => query("schedule-enable-confirm-cancel")!.click());

    await render([view({ connectIfNeeded: true })]);
    act(() => query("schedule-enable-s1")!.click());
    expect(query("schedule-confirm-connects")!.textContent).toContain("never asking");
  });

  it("cancelling the confirmation leaves the schedule disabled", async () => {
    await render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    act(() => query("schedule-enable-confirm-cancel")!.click());
    expect(setScheduleEnabled).not.toHaveBeenCalled();
  });

  it("toggles an already-confirmed schedule without asking again", async () => {
    await render([view({ confirmedAt: "2026-09-26T00:00:00Z" })]);
    await act(async () => query("schedule-enable-s1")!.click());
    expect(query("schedule-confirm-hosts")).toBeNull();
    expect(setScheduleEnabled).toHaveBeenCalledWith("s1", true, false);
  });

  it("the global switch pauses all schedules", async () => {
    await render([view({ enabled: true, confirmedAt: "x" })]);
    await act(async () => query("schedules-pause-toggle")!.click());
    expect(setSchedulesPaused).toHaveBeenCalledWith(true);
  });

  it("shows paused, running and disabled states and the last result", async () => {
    await render(
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

  it("expands a schedule to its recent attempts, including skips and their reasons", async () => {
    const now = Date.now();
    const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
    const history = [
      {
        at: iso(1),
        startedAt: iso(3),
        durationMs: 125_000,
        outcome: "completed" as const,
        message: "Ran on 2 terminals",
        workflowRunIds: ["run-a", "run-b"],
      },
      {
        at: iso(10),
        outcome: "skipped" as const,
        message: "Skipped: the previous run was still in progress",
        catchUp: true,
      },
      { at: iso(20), outcome: "skipped" as const, message: "Missed the run due at 09:00" },
    ];
    await render([view({ lastResult: history[0], history })]);

    expect(query("schedule-attempts-s1")).toBeNull();
    const toggle = query("schedule-attempts-toggle-s1")!;
    expect(toggle.textContent).toContain("Show recent attempts (3)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const items = query("schedule-attempts-s1")!.querySelectorAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Completed");
    expect(items[0].textContent).toContain("2m 05s");
    expect(query("schedule-attempt-runs-s1-0")!.textContent).toBe("2 workflow runs in history");
    expect(query("schedule-attempt-runs-s1-0")!.getAttribute("title")).toBe("run-a\nrun-b");
    expect(items[1].textContent).toContain("Skipped");
    expect(items[1].textContent).toContain("catch-up");
    expect(items[1].textContent).toContain("previous run was still in progress");
    expect(items[2].textContent).toContain("Missed the run due at 09:00");
    expect(query("schedule-attempt-runs-s1-1")).toBeNull();

    act(() => toggle.click());
    expect(query("schedule-attempts-s1")).toBeNull();
  });

  it("links a scheduled macro attempt to its macro run-history record (#3543)", async () => {
    const attempt = {
      at: new Date().toISOString(),
      outcome: "completed" as const,
      message: "Ran on 1 terminal",
      macroRunIds: ["mrun-1"],
    };
    await render([view({ lastResult: attempt, history: [attempt] })]);

    act(() => query("schedule-attempts-toggle-s1")!.click());
    expect(query("schedule-attempt-runs-s1-0")!.textContent).toBe("1 macro run in history");
    expect(query("schedule-attempt-runs-s1-0")!.getAttribute("title")).toBe("mrun-1");
  });

  it("offers no attempts toggle before the first attempt", async () => {
    await render([view()]);
    expect(query("schedule-attempts-toggle-s1")).toBeNull();
  });

  it("edits and deletes a schedule", async () => {
    await render([view()]);
    act(() => query("schedule-edit-s1")!.click());
    expect(openScheduleEditor).toHaveBeenCalledWith({ scheduleId: "s1" });
    act(() => query("schedule-delete-s1")!.click());
    await act(async () => query("confirm-delete-confirm")!.click());
    await flush();
    expect(deleteSchedule).toHaveBeenCalledWith("s1");
  });
});
