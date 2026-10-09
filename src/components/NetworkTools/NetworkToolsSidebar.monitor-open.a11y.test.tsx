/**
 * The monitor row's info area opens the monitor's detail view; it used to be a
 * click-only `<div>`, unreachable from the keyboard (#4349, audit A11Y2-008).
 * It is now a real, named `<button>`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { withTooltip } from "@/test/tooltip";
import { checkA11y } from "@/test/axe";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const MONITOR: HttpMonitorState = {
  config: {
    id: "m1",
    url: "https://example.com/health",
    intervalMs: 30_000,
    method: "GET",
    expectedStatus: 200,
    timeoutMs: 10_000,
  },
  running: true,
  paused: false,
};

let container: HTMLDivElement;
let root: Root;
const openTab = vi.fn();

async function render() {
  vi.mocked(networkHttpMonitorList).mockResolvedValue([MONITOR]);
  await act(async () => {
    root.render(withTooltip(<NetworkToolsSidebar />));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NetworkToolsSidebar — monitor info is a button (#4349)", () => {
  beforeEach(() => {
    openTab.mockReset();
    useAppStore.setState({ httpMonitors: [], openNetworkDiagnosticTab: openTab });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useAppStore.setState({ httpMonitors: [] });
  });

  it("renders the info area as a named, focusable button that opens the monitor", async () => {
    await render();
    const info = container.querySelector<HTMLElement>('[data-testid="monitor-open-m1"]');
    expect(info).not.toBeNull();
    expect(info!.tagName).toBe("BUTTON");
    expect(info!.getAttribute("type")).toBe("button");
    expect(info!.getAttribute("aria-label")).toBe("Open monitor https://example.com/health");
    expect(info!.tabIndex).toBe(0);
    // The visible status is kept as the description, every reference resolving.
    const described = (info!.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual(["checking…"]);
    // Enter/Space on a native button dispatch click.
    act(() => info!.click());
    expect(openTab).toHaveBeenCalledWith("http-monitor");
  });

  it("has no axe violations in the monitor row", async () => {
    await render();
    const row = container.querySelector('[data-testid="monitor-row-m1"]')!;
    expect(await checkA11y(row)).toHaveNoViolations();
  });
});
