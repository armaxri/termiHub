import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { checkA11y } from "@/test/axe";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import type { ScheduleView } from "@/types/schedule";
import { SchedulesSettings, schedulesSummary } from "./SchedulesSettings";

/**
 * Settings ▸ Automation ▸ Schedules (#5860, R-018): schedules have one list, in
 * the Automations sidebar. This page says so, counts them and opens that list;
 * it does not show a second list with other controls.
 */

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: "s1",
    name: "Nightly backup",
    action: { kind: "automation", automationId: "m-1" },
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

function render(schedules: ScheduleView[], paused = false) {
  act(() => {
    useAppStore.setState({ schedules, schedulesPaused: paused } as never);
  });
  act(() => root.render(<SchedulesSettings />));
}

describe("SchedulesSettings (#5860)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAutomationSections.setState({ schedulesOpen: false, historyOpen: false });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("says where the schedules are and how many there are, without a second list", () => {
    render([view(), view({ id: "s2", name: "Health", enabled: false })]);
    expect(query("schedules-settings")?.textContent).toContain("Automations sidebar");
    expect(query("schedules-settings-summary")?.textContent).toBe("2 schedules, 1 on.");
    expect(query("schedule-item-s1")).toBeNull();
    expect(query("schedules-new-btn")).toBeNull();
  });

  it("opens the one list: the Automations view with its Schedules section", () => {
    useAppStore.setState({ sidebarView: "connections", sidebarCollapsed: true } as never);
    render([]);
    act(() => query("schedules-settings-open")!.click());
    expect(useAppStore.getState().sidebarView).toBe("automations");
    expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    expect(useAutomationSections.getState().schedulesOpen).toBe(true);
  });

  it.each([
    [0, 0, false, "No schedules yet."],
    [1, 1, false, "1 schedule, on."],
    [1, 0, false, "1 schedule, off."],
    [3, 3, false, "3 schedules, all on."],
    [3, 0, false, "3 schedules, none on."],
    [3, 2, true, "3 schedules, 2 on; all paused."],
  ])("counts %i schedules with %i on (paused %s)", (total, on, paused, text) => {
    expect(schedulesSummary(total, on, paused)).toBe(text);
  });

  it("has no a11y violations", async () => {
    render([view()]);
    expect(await checkA11y()).toHaveNoViolations();
  });
});
