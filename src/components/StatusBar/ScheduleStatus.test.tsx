import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { useAutomationSections } from "@/components/AutomationSidebar/automationSections";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { ScheduleView } from "@/types/schedule";
import { ScheduleStatus } from "./ScheduleStatus";

setupSettingsRegion();

function view(id: string, enabled: boolean, running = false): ScheduleView {
  return {
    id,
    name: id,
    action: { kind: "automation", automationId: "wf" },
    targets: { kind: "connections", connectionIds: ["c"] },
    rule: { kind: "interval", everyMinutes: 5 },
    missedRuns: "skip",
    enabled,
    running,
    createdAt: "",
    updatedAt: "",
  };
}

describe("ScheduleStatus (PROD-043)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const pill = () => container.querySelector<HTMLButtonElement>('[data-testid="schedule-status"]');
  const render = () => act(() => root.render(withTooltip(<ScheduleStatus />)));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useAppStore.setState(useAppStore.getInitialState());
    useAutomationSections.setState(useAutomationSections.getInitialState());
  });

  it("renders nothing while no schedule is enabled", () => {
    useAppStore.setState({ schedules: [view("a", false)] });
    render();
    expect(pill()).toBeNull();
  });

  it("counts the enabled schedules and flags a running one", () => {
    useAppStore.setState({ schedules: [view("a", true), view("b", true, true), view("c", false)] });
    render();
    expect(pill()!.textContent).toBe("2 schedules active · running");
  });

  it("says paused under the global pause", () => {
    useAppStore.setState({ schedules: [view("a", true)], schedulesPaused: true });
    render();
    expect(pill()!.textContent).toBe("Schedules paused");
  });

  it.each([
    ["another view", { sidebarView: "connections", sidebarCollapsed: false }],
    ["a closed sidebar", { sidebarView: "automations", sidebarCollapsed: true }],
    ["Automations already open", { sidebarView: "automations", sidebarCollapsed: false }],
  ] as const)("opens the Schedules section of Automations from %s (#5818)", (_name, before) => {
    useAppStore.setState({ schedules: [view("a", true)], ...before });
    render();
    act(() => pill()!.click());
    // Never closes the sidebar it leads to.
    const { sidebarView, sidebarCollapsed } = useAppStore.getState();
    expect({ sidebarView, sidebarCollapsed }).toEqual({
      sidebarView: "automations",
      sidebarCollapsed: false,
    });
    expect(useAutomationSections.getState().schedulesOpen).toBe(true);
  });
});
