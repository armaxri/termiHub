/**
 * Verifies the Network Tools sidebar buttons compose from the shared `Button`
 * primitive (issue #1109), replacing the bespoke `network-sidebar__*` buttons.
 *
 * Pins:
 *  - Quick-action / New-monitor rows render the `Button` primitive (ghost, full
 *    width) plus the thin `network-sidebar__list-action` layout modifier, keep their
 *    `data-testid`, and still trigger their action.
 *  - The Refresh and Stop icon-only controls render as ghost `Button`s wrapped in
 *    a `Tooltip`, keeping their `aria-label` with no bare `title` leak.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList, networkHttpMonitorStop } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

function makeMonitor(id: string): HttpMonitorState {
  return {
    config: {
      id,
      url: "https://example.com",
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: true,
    paused: false,
  };
}

let container: HTMLDivElement;
let root: Root;
const openTab = vi.fn();

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NetworkToolsSidebar — Button primitive migration (#1109)", () => {
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

  it("renders quick-action rows as the ghost Button primitive with the list modifier", async () => {
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const ping = container.querySelector<HTMLButtonElement>(
      '[data-testid="network-quick-action-ping"]'
    );
    expect(ping).not.toBeNull();
    expect(ping?.classList.contains("ui-btn")).toBe(true);
    expect(ping?.classList.contains("ui-btn--ghost")).toBe(true);
    expect(ping?.classList.contains("ui-btn--full")).toBe(true);
    expect(ping?.classList.contains("network-sidebar__list-action")).toBe(true);
    // No leftover bespoke button class.
    expect(ping?.classList.contains("network-sidebar__action")).toBe(false);
  });

  it("fires the quick-action handler on click", async () => {
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const ping = container.querySelector<HTMLButtonElement>(
      '[data-testid="network-quick-action-ping"]'
    )!;
    act(() => ping.click());
    expect(openTab).toHaveBeenCalledWith("ping");
  });

  it("renders the New Monitor row as the ghost Button primitive with the list modifier", async () => {
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const add = container.querySelector<HTMLButtonElement>('[data-testid="network-new-monitor"]');
    expect(add).not.toBeNull();
    expect(add?.classList.contains("ui-btn--ghost")).toBe(true);
    expect(add?.classList.contains("ui-btn--full")).toBe(true);
    expect(add?.classList.contains("network-sidebar__list-action")).toBe(true);
    act(() => add!.click());
    expect(openTab).toHaveBeenCalledWith("http-monitor");
  });

  it("renders the Refresh control as a ghost icon Button keeping its aria-label", async () => {
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh monitors"]'
    );
    expect(refresh).not.toBeNull();
    expect(refresh?.classList.contains("ui-btn--ghost")).toBe(true);
    // The tooltip must not leak into the accessible name as a bare title.
    expect(refresh?.getAttribute("title")).toBeNull();
  });

  it("renders the monitor Stop control as a ghost icon Button that stops the monitor", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    useAppStore.setState({ httpMonitors: [makeMonitor("mon-1")] });
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop monitor"]');
    expect(stop).not.toBeNull();
    expect(stop?.classList.contains("ui-btn--ghost")).toBe(true);
    expect(stop?.getAttribute("title")).toBeNull();

    await act(async () => {
      stop!.click();
    });
    await flush();
    expect(networkHttpMonitorStop).toHaveBeenCalledWith("mon-1");
  });
});
