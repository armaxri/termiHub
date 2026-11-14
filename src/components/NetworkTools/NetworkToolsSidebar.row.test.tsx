/**
 * The sidebar monitor rows are built on the shared SidebarListItem (#5193,
 * audit UI-006): status dot + name + actions on the first line, actions
 * reachable from the keyboard. Since #5789 the row follows the list-row rule:
 * the name (the URL when unnamed), the description and a marker only when the
 * state needs attention; the URL, method, interval and latest reading are in
 * the tooltip (the row's accessible description).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkHttpMonitorList,
  networkHttpMonitorPause,
  networkHttpMonitorRemove,
} from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const NOW = 1_700_000_000_000;

function monitor(id: string, overrides: Partial<HttpMonitorState> = {}): HttpMonitorState {
  return {
    config: {
      id,
      url: `https://${id}.example.com/health`,
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: true,
    paused: false,
    lastResult: { monitorId: id, statusCode: 200, latencyMs: 42, ok: true, timestampMs: NOW },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const openTab = vi.fn();

async function render(monitors: HttpMonitorState[]) {
  vi.mocked(networkHttpMonitorList).mockResolvedValue(monitors);
  await act(async () => {
    root.render(withTooltip(<NetworkToolsSidebar />));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const actionLabels = (id: string) =>
  [
    ...container.querySelectorAll(
      `[data-testid="monitor-row-${id}"] .sidebar-list-item__actions button`
    ),
  ].map((b) => b.getAttribute("aria-label"));

describe("NetworkToolsSidebar — monitor rows on SidebarListItem (#5193)", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    openTab.mockReset();
    useAppStore.setState({ httpMonitors: [], openNetworkDiagnosticTab: openTab });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    useAppStore.setState({ httpMonitors: [] });
  });

  it("puts dot, URL and actions on the header line and the reading in the tooltip", async () => {
    await render([monitor("up")]);
    const row = q('[data-testid="monitor-row-up"]')!;
    expect(row.classList.contains("sidebar-list-item")).toBe(true);
    const header = row.querySelector(".sidebar-list-item__header")!;
    expect(header.querySelector('[data-testid="monitor-status-up"]')).not.toBeNull();
    expect(header.querySelector('[data-testid="monitor-url-up"]')?.textContent).toBe(
      "up.example.com/health"
    );
    expect(header.querySelector(".sidebar-list-item__actions")).not.toBeNull();
    // An up monitor needs no marker: no details line at all (#5789).
    expect(row.querySelector(".sidebar-list-item__details")).toBeNull();
    expect(row.getAttribute("aria-description")).toBe(
      "GET every 30s · expects 200. Last check: 200 in 42 ms, just now"
    );
  });

  it("shows a named monitor's name and description, its URL in the tooltip (#5789)", async () => {
    await render([
      monitor("shop", {
        config: {
          ...monitor("shop").config,
          name: "Shop front",
          description: "Landing page health",
        },
      }),
    ]);
    const row = q('[data-testid="monitor-row-shop"]')!;
    expect(q('[data-testid="monitor-url-shop"]')?.textContent).toBe("Shop front");
    expect(q('[data-testid="monitor-description-shop"]')?.textContent).toBe("Landing page health");
    expect(row.textContent).not.toContain("example.com");
    expect(row.textContent).not.toContain("42");
    expect(row.getAttribute("aria-description")).toBe(
      "https://shop.example.com/health. GET every 30s · expects 200. " +
        "Last check: 200 in 42 ms, just now"
    );
    expect(q('[data-testid="monitor-open-shop"]')?.getAttribute("aria-label")).toBe(
      "Open monitor Shop front"
    );
  });

  it.each([
    ["paused", monitor("a", { paused: true }), "Paused"],
    ["stopped", monitor("a", { running: false }), "Stopped"],
  ])("marks a %s monitor on the row", async (_name, m, label) => {
    await render([m]);
    expect(q('[data-testid="monitor-marker-a"]')?.textContent).toBe(label);
  });

  it("shows no marker while the first check runs", async () => {
    await render([monitor("a", { lastResult: undefined })]);
    expect(q('[data-testid="monitor-meta-a"]')).toBeNull();
  });

  it.each([
    ["up", monitor("a"), "success", "Up"],
    [
      "down",
      monitor("a", { lastResult: { ...monitor("a").lastResult!, ok: false } }),
      "error",
      "Down",
    ],
    ["paused", monitor("a", { paused: true }), "neutral", "Paused"],
    ["stopped", monitor("a", { running: false }), "neutral", "Stopped"],
    ["checking", monitor("a", { lastResult: undefined }), "neutral", "Checking"],
  ])("labels the %s status dot", async (_name, m, tone, label) => {
    await render([m]);
    const dot = q('[data-testid="monitor-status-a"]')!;
    expect(dot.classList.contains(`status-dot--${tone}`)).toBe(true);
    expect(dot.getAttribute("aria-label")).toBe(label);
  });

  it("offers Open, Pause, Stop and Remove on a running monitor, Resume when paused", async () => {
    await render([monitor("run"), monitor("halt", { paused: true })]);
    expect(actionLabels("run")).toEqual([
      "Open monitor https://run.example.com/health",
      "Pause monitor",
      "Stop monitor",
      "Delete monitor",
    ]);
    expect(actionLabels("halt")).toEqual([
      "Open monitor https://halt.example.com/health",
      "Resume monitor",
      "Stop monitor",
      "Delete monitor",
    ]);
  });

  it("keeps every action in the tab order", async () => {
    await render([monitor("run")]);
    const buttons = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="monitor-row-run"] .sidebar-list-item__actions button'
    );
    for (const b of buttons) expect(b.tabIndex).toBe(0);
  });

  it("opens the monitor on a row click, but a row action does not open it", async () => {
    await render([monitor("run")]);
    act(() => q('[data-testid="monitor-url-run"]')!.click());
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith("http-monitor");

    await act(async () => {
      q<HTMLButtonElement>('[data-testid="monitor-row-run"] [aria-label="Pause monitor"]')!.click();
    });
    expect(networkHttpMonitorPause).toHaveBeenCalledWith("run");
    await act(async () => {
      q<HTMLButtonElement>(
        '[data-testid="monitor-row-run"] [aria-label="Delete monitor"]'
      )!.click();
    });
    expect(networkHttpMonitorRemove).toHaveBeenCalledWith("run");
    expect(openTab).toHaveBeenCalledTimes(1);
  });

  it("marks a failed check as Down, with the error in the tooltip", async () => {
    await render([
      monitor("dn", {
        lastResult: { ...monitor("dn").lastResult!, ok: false, error: "connection refused" },
      }),
    ]);
    const down = q('[data-testid="monitor-meta-dn"] .network-sidebar__monitor-down');
    expect(down?.textContent).toBe("Down");
    expect(q('[data-testid="monitor-row-dn"]')?.getAttribute("aria-description")).toContain(
      "Last check failed just now: connection refused"
    );
  });
});
