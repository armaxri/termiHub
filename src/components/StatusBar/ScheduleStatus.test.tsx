import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import type { ScheduleView } from "@/types/schedule";
import { ScheduleStatus } from "./ScheduleStatus";

function view(id: string, enabled: boolean, running = false): ScheduleView {
  return {
    id,
    name: id,
    action: { kind: "workflow", workflowId: "wf" },
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

  it("says paused under the global pause and opens the Workflows sidebar on click", () => {
    const setSidebarView = vi.fn();
    useAppStore.setState({ schedules: [view("a", true)], schedulesPaused: true, setSidebarView });
    render();
    expect(pill()!.textContent).toBe("Schedules paused");
    act(() => pill()!.click());
    expect(setSidebarView).toHaveBeenCalledWith("workflows");
  });
});
