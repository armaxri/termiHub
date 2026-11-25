import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { chooseFrom } from "@/test/automationEditorHarness";
import { flushAsync } from "@/test/flushAsync";
import { LOCAL_PROCESS_REASON } from "@/utils/localProcessGate";
import { useAppStore } from "@/store/appStore";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { withTooltip } from "@/test/tooltip";
import type { ScheduleView } from "@/types/schedule";
import { SchedulesSection, type SchedulesSectionProps } from "./SchedulesSection";

const preview = vi.hoisted(() => vi.fn());
vi.mock("@/services/scheduleApi", async (original) => ({
  ...(await original<typeof import("@/services/scheduleApi")>()),
  previewScheduleNextRun: preview,
}));
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
    action: { kind: "automation", automationId: "wf-1" },
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

async function render(
  schedules: ScheduleView[],
  paused = false,
  collapse?: SchedulesSectionProps["collapse"]
) {
  // Wrapped in act: the second render in a test updates an already-mounted tree.
  act(() => {
    useAppStore.setState({
      schedules,
      schedulesPaused: paused,
      automations: [
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
  await act(async () => root.render(withTooltip(<SchedulesSection collapse={collapse} />)));
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
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(2, 0, 0, 0);
    preview.mockReset().mockResolvedValue(next.toISOString());
    useAutomationSections.setState({ historyOpen: false, historyAutomationId: null });
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

  it("offers a New schedule button in the empty state (#5633)", async () => {
    await render([]);
    act(() => query("schedules-empty-new-btn")!.click());
    expect(openScheduleEditor).toHaveBeenCalledWith();
  });

  describe("collapsed in the Automations sidebar (#5818)", () => {
    const onChange = vi.fn();
    const closed = { expanded: false, onChange };
    beforeEach(() => onChange.mockClear());

    it("says on the closed header that a run was missed, quieter than a failure", async () => {
      const missed = {
        at: new Date().toISOString(),
        outcome: "skipped",
        missedDueAt: new Date().toISOString(),
      } as ScheduleView["lastResult"];
      const failed = { at: "", outcome: "failed" } as ScheduleView["lastResult"];
      await render([view({ enabled: true, lastResult: missed })], false, closed);
      expect(query("schedules-section-toggle")!.textContent).toBe("Schedules (1) · 1 not run");
      await render(
        [
          view({ enabled: true, lastResult: missed }),
          view({ id: "s2", enabled: true, lastResult: failed }),
        ],
        false,
        closed
      );
      expect(query("schedules-section-toggle")!.textContent).toBe("Schedules (2) · 1 failed");
    });

    it("keeps the header, its count and New schedule, and hides the list", async () => {
      await render([view(), view({ id: "s2" })], false, closed);
      expect(query("schedules-section-toggle")!.textContent).toBe("Schedules (2)");
      expect(query("schedules-list")).toBeNull();
      act(() => query("schedules-section-toggle")!.click());
      expect(onChange).toHaveBeenCalledWith(true);
      // A new schedule's row must be in view once it is saved.
      onChange.mockClear();
      act(() => query("schedules-new-btn")!.click());
      expect(openScheduleEditor).toHaveBeenCalledWith();
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it("opens to the list", async () => {
      await render([view()], false, { expanded: true, onChange });
      expect(query("schedule-item-s1")).not.toBeNull();
      act(() => query("schedules-section-toggle")!.click());
      expect(onChange).toHaveBeenCalledWith(false);
    });

    it("says on the header that a scheduled run failed, open too (B-034)", async () => {
      const failed = {
        at: new Date().toISOString(),
        outcome: "failed",
        catchUp: false,
      } as ScheduleView["lastResult"];
      await render([view({ enabled: true, lastResult: failed })], false, closed);
      expect(query("schedules-section-toggle")!.textContent).toContain("1 failed");
      await render([view({ enabled: false, lastResult: failed })], false, closed);
      expect(query("schedules-section-toggle")!.textContent).not.toContain("failed");
      await render([view({ enabled: true, lastResult: failed })], false, {
        expanded: true,
        onChange,
      });
      expect(query("schedules-section-toggle")!.textContent).toContain("1 failed");
    });

    it("offers Pause all only with something to pause, or to undo a pause (R-135)", async () => {
      await render([], false, closed);
      expect(query("schedules-pause-toggle")).toBeNull();
      await render([], true, closed);
      expect(query("schedules-pause-toggle")).not.toBeNull();
      await render([view()], false, closed);
      expect(query("schedules-pause-toggle")).not.toBeNull();
    });
  });

  const line = (what: string, id = "s1") => query(`schedule-${what}-${id}`)?.textContent ?? null;
  const tomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(2, 0, 0, 0);
    return d.toISOString();
  };
  const last = (over: Partial<NonNullable<ScheduleView["lastResult"]>>) => ({
    at: new Date().toISOString(),
    outcome: "completed" as const,
    ...over,
  });

  describe("a row answers when, what, where and how it went (A-040 to A-042)", () => {
    const on = (over: Partial<ScheduleView> = {}) =>
      view({ enabled: true, confirmedAt: "x", nextRunAt: tomorrow(), ...over });

    it("says when it next runs, its rule, the automation and the connections", async () => {
      await render([on()]);
      expect(line("status")).toBe("Next run tomorrow 02:00");
      expect(line("rule")).toBe("Every 15 minutes");
      expect(line("what")).toBe("Uptime on web-1, web-2");
      expect(query("schedule-last-s1")).toBeNull();
      expect(query("schedule-blocked-s1")).toBeNull();
    });

    it("says off, paused and running", async () => {
      await render(
        [
          on({ id: "a" }),
          on({ id: "b", running: true }),
          view({ id: "c", confirmedAt: "x" }),
          view({ id: "d" }),
        ],
        true
      );
      expect(line("status", "a")).toBe("Paused");
      expect(line("status", "b")).toBe("Running now");
      expect(line("status", "c")).toBe("Off");
      expect(line("status", "d")).toBe("Off until you switch it on");
    });

    it("gives the whole reason of a missed run, which is never cut", async () => {
      await render([
        on({
          lastResult: last({
            outcome: "skipped",
            missedDueAt: new Date(new Date().setHours(2, 0, 0, 0)).toISOString(),
            message: "termiHub was closed or the computer was asleep",
          }),
        }),
      ]);
      expect(line("last")).toBe(
        "Last run missed: termiHub was closed or the computer was asleep (due today 02:00) Show in History"
      );
      const css = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "Schedules.css"),
        "utf8"
      );
      for (const rule of css.match(/\.schedules__line[^{]*\{[^}]*\}/g) ?? []) {
        expect(rule).not.toMatch(/ellipsis|nowrap|line-clamp/);
      }
    });

    it("a coloured dot always means an outcome, never 'on'", async () => {
      await render([
        on({ id: "ok", lastResult: last({}) }),
        on({ id: "bad", lastResult: last({ outcome: "failed", message: "web-1: it broke" }) }),
        on({ id: "none" }),
      ]);
      const dots = (id: string) =>
        [...query(`schedule-item-${id}`)!.querySelectorAll(".status-dot")].map((d) => d.className);
      expect(dots("none")).toEqual([]);
      expect(dots("ok")).toHaveLength(1);
      expect(dots("ok")[0]).toContain("status-dot--success");
      expect(dots("bad")[0]).toContain("status-dot--error");
      expect(line("last", "bad")).toContain("Last run failed: web-1: it broke");
    });

    it("says that it will not run, and then promises no next run", async () => {
      await render([
        on({ id: "gone", targets: { kind: "connections", connectionIds: ["Work/Old Box"] } }),
        on({ id: "noauto", action: { kind: "automation", automationId: "zz" } }),
      ]);
      expect(line("status", "gone")).toBe("On");
      expect(line("what", "gone")).toBe("Uptime on Deleted connection “Old Box”");
      expect(line("blocked", "gone")).toBe(
        "Will not run: its connections were deleted. Choose a connection"
      );
      // The way to repair it, where the reason stands (B-017).
      act(() => query("schedule-repair-gone")!.click());
      expect(openScheduleEditor).toHaveBeenCalledWith({
        scheduleId: "gone",
        startAtConnections: true,
      });
      expect(query("schedule-repair-noauto")).toBeNull();
      expect(line("what", "noauto")).toContain("Deleted automation on");
      expect(line("blocked", "noauto")).toBe("Will not run: its automation was deleted.");
    });

    it("says that an automation asking for a value cannot run by itself (A-047)", async () => {
      await render([on()]);
      act(() => {
        useAppStore.setState((state) => ({
          automations: state.automations.map((x) => ({
            ...x,
            parameters: [{ name: "env", type: "string" as const, required: true }],
          })),
        }));
      });
      expect(line("blocked")).toContain("it asks for “env”");
    });

    it("opens the History on the automation's runs (A-043)", async () => {
      await render([on()]);
      await chooseFrom("schedule-more-s1", "schedule-menu-history-s1");
      expect(useAutomationSections.getState()).toMatchObject({
        historyOpen: true,
        historyAutomationId: "wf-1",
      });
    });

    it("marks the schedule that was just saved, and only for a moment", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await render([on(), on({ id: "s2" })]);
        const marked = () =>
          ["s1", "s2"].filter((id) =>
            query(`schedule-item-${id}`)!.classList.contains("automation-item--just-saved")
          );
        expect(marked()).toEqual([]);
        act(() => useAutomationSections.getState().markScheduleSaved("s2"));
        expect(marked()).toEqual(["s2"]);
        act(() => vi.advanceTimersByTime(3001));
        expect(marked()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("shows the user's description muted under the name, only when set (#5757)", async () => {
    await render([
      view({ id: "a", description: "Checks the web hosts" }),
      view({ id: "b", description: undefined }),
    ]);
    expect(query("schedule-description-a")!.textContent).toBe("Checks the web hosts");
    expect(query("schedule-description-b")).toBeNull();
  });

  it("asks for confirmation listing the hosts before the first enable", async () => {
    await render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    await flushAsync();
    expect(setScheduleEnabled).not.toHaveBeenCalled();
    const hosts = query("schedule-confirm-hosts")!;
    expect(hosts.textContent).toContain("web-1");
    expect(hosts.textContent).toContain("web-2");
    const dialog = query("schedule-enable-confirm")!.textContent ?? "";
    expect(dialog).toContain("Switch on “Health”?");
    expect(dialog).toContain("Every 15 minutes, termiHub runs “Uptime”");
    expect(dialog).not.toMatch(/enable|disable/i);
    expect(query("schedule-confirm-next")!.textContent).toBe("First run: tomorrow 02:00.");
    await act(async () => query("schedule-enable-confirm-confirm")!.click());
    await flush();
    expect(setScheduleEnabled).toHaveBeenCalledWith("s1", true, true);
  });

  it("the confirmation says a connecting schedule also connects the hosts (#3527)", async () => {
    await render([view()]);
    act(() => query("schedule-enable-s1")!.click());
    expect(query("schedule-confirm-connects")).toBeNull();
    expect(query("schedule-confirm-skips")!.textContent).toContain("is skipped");
    act(() => query("schedule-enable-confirm-cancel")!.click());

    await render([view({ connectIfNeeded: true })]);
    act(() => query("schedule-enable-s1")!.click());
    expect(query("schedule-confirm-connects")!.textContent).toContain("never asking");
  });

  it("the confirmation says when there is nothing left to run on", async () => {
    await render([view({ targets: { kind: "connections", connectionIds: ["Work/Old Box"] } })]);
    act(() => query("schedule-enable-s1")!.click());
    await flushAsync();
    expect(query("schedule-confirm-hosts")!.textContent).toBe("Deleted connection “Old Box”");
    expect(query("schedule-confirm-gone")!.textContent).toBe(
      "Nothing will run: its connections were deleted."
    );
    expect(query("schedule-confirm-next")).toBeNull();
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

  it("says why a schedule of a local-process automation will not run (#5818)", async () => {
    await render([view({})]);
    expect(query("schedule-blocked-s1")).toBeNull();
    act(() => {
      useAppStore.setState((state) => ({
        automations: state.automations.map((x) => ({
          ...x,
          steps: [{ kind: "run-local-process" as const, program: "make", args: [] }],
        })),
      }));
    });
    expect(query("schedule-blocked-s1")!.textContent).toBe(LOCAL_PROCESS_REASON);
  });

  it("edits and deletes a schedule", async () => {
    await render([view()]);
    act(() => query("schedule-edit-s1")!.click());
    expect(openScheduleEditor).toHaveBeenCalledWith({ scheduleId: "s1" });
    await chooseFrom("schedule-more-s1", "schedule-menu-edit-s1");
    expect(openScheduleEditor).toHaveBeenCalledTimes(2);
    await chooseFrom("schedule-more-s1", "schedule-menu-delete-s1");
    await act(async () => query("confirm-delete-confirm")!.click());
    await flush();
    expect(deleteSchedule).toHaveBeenCalledWith("s1");
  });
});
