/**
 * Schedules header at narrow sidebar widths (#4709): the "Pause all" label must
 * never wrap and the "+" must never clip. Below the compact width the label
 * gives way to a tooltip; the toggle and "+" keep their accessible names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import { installResizeObserverMock, type ResizeObserverMock } from "@/test/resizeObserver";
import { SchedulesSection, SCHEDULES_HEADER_COMPACT_WIDTH } from "./SchedulesSection";

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
let ro: ResizeObserverMock;

const query = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function render() {
  act(() => {
    useAppStore.setState({
      schedules: [],
      schedulesPaused: false,
      setSchedulesPaused: vi.fn(() => Promise.resolve()),
      openScheduleEditor: vi.fn(),
    } as never);
  });
  await act(async () => root.render(withTooltip(<SchedulesSection />)));
  await flushAsync();
}

function header(): HTMLElement {
  return query("schedules-header") as HTMLElement;
}

describe("SchedulesSection header at narrow widths (#4709)", () => {
  beforeEach(() => {
    ro = installResizeObserverMock();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    ro.restore();
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("shows the Pause all label when there is room", async () => {
    await render();
    ro.resize(SCHEDULES_HEADER_COMPACT_WIDTH + 40);
    expect(header().textContent).toContain("Pause all");
    expect(query("schedules-pause-toggle")).not.toBeNull();
    expect(query("schedules-new-btn")).not.toBeNull();
  });

  it("drops the label but keeps both controls named at the minimum width", async () => {
    await render();
    // 200px sidebar minus the header's horizontal padding.
    ro.resize(184);
    expect(header().textContent).not.toContain("Pause all");
    const toggle = query("schedules-pause-toggle");
    const add = query("schedules-new-btn");
    expect(toggle?.getAttribute("aria-label")).toBe("Pause all schedules");
    expect(add?.getAttribute("aria-label")).toBe("New schedule");
    // Both controls sit in the non-shrinking actions slot of the header.
    const actions = header().querySelector(".sidebar-section-header__actions");
    expect(actions?.contains(toggle as Node)).toBe(true);
    expect(actions?.contains(add as Node)).toBe(true);
    expect(await checkA11y(container)).toHaveNoViolations();
  });

  it("never lets the header controls wrap or shrink", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../Sidebar/SidebarSectionHeader.css"),
      "utf8"
    );
    const actions = /\.sidebar-section-header__actions\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(actions).toMatch(/flex-shrink:\s*0/);
    expect(actions).toMatch(/white-space:\s*nowrap/);
    const title = /\.sidebar-section-header__title\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(title).toMatch(/min-width:\s*0/);
  });
});
