/**
 * Tests for the light window-awareness of the Open Connections panel (#1926,
 * epic #1899).
 *
 * When more than one native window is open, each session row shows an
 * owning-window chip (e.g. "Window 2") sourced from #1900's
 * `session_id → owning_window` map; clicking the chip focuses that window. With
 * a single window — or for an unclaimed session with no ownership entry — no
 * chip is shown, so single-window users see no change. Kill actions stay global.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { LocalSessionInfo } from "@/services/api";
import type { WindowInfoState } from "@/hooks/useWindowInfo";

const listLocalSessions = vi.fn<() => Promise<LocalSessionInfo[]>>();
const listSessionOwners = vi.fn<() => Promise<Record<string, string>>>();
const focusWindow = vi.fn((_label: string) => Promise.resolve());

vi.mock("@/services/api", () => ({
  listLocalSessions: () => listLocalSessions(),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  listSessionOwners: () => listSessionOwners(),
  focusWindow: (label: string) => focusWindow(label),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  pruneDeadAgents: vi.fn(() => Promise.resolve([])),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false, sessionCount: 0 })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorStopAll: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
}));

// The window count drives whether the affordance is shown at all — mock the hook
// directly (as the StatusBar window test does) so the count is deterministic.
let windowInfo: WindowInfoState = { label: "main", name: "Main Window", count: 1 };
vi.mock("@/hooks/useWindowInfo", () => ({
  useWindowInfo: () => windowInfo,
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

const OWNED_SESSION: LocalSessionInfo = {
  id: "sess-owned",
  title: "Owned Shell",
  connectionType: "local",
  alive: true,
};

const UNCLAIMED_SESSION: LocalSessionInfo = {
  id: "sess-unclaimed",
  title: "Unclaimed Shell",
  connectionType: "local",
  alive: true,
};

function rowMatching(text: string): Element | undefined {
  return Array.from(document.querySelectorAll(".oc-row")).find((r) =>
    r.querySelector(".oc-row__title")?.textContent?.includes(text)
  );
}

function windowChip(rowText: string): HTMLButtonElement | null {
  const row = rowMatching(rowText);
  return (row?.querySelector("[data-testid='oc-row-window']") as HTMLButtonElement) ?? null;
}

describe("OpenConnectionsModal — owning-window affordance (#1926)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    listLocalSessions.mockReset();
    listSessionOwners.mockReset();
    focusWindow.mockClear();
    listLocalSessions.mockResolvedValue([OWNED_SESSION, UNCLAIMED_SESSION]);
    listSessionOwners.mockResolvedValue({ "sess-owned": "win-2" });
    windowInfo = { label: "main", name: "Main Window", count: 1 };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("shows the owning-window chip for a claimed session when >1 window is open", async () => {
    windowInfo = { label: "main", name: "Main Window", count: 2 };
    await renderModal();

    const chip = windowChip("Owned Shell");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Window 2");
  });

  it("focuses the owning window when the chip is clicked", async () => {
    windowInfo = { label: "main", name: "Main Window", count: 2 };
    await renderModal();

    const chip = windowChip("Owned Shell");
    await act(async () => {
      chip?.click();
      await Promise.resolve();
    });
    expect(focusWindow).toHaveBeenCalledWith("win-2");
  });

  it("shows no chip for an unclaimed session even with >1 window", async () => {
    windowInfo = { label: "main", name: "Main Window", count: 2 };
    await renderModal();

    // The owned session gets a chip; the unclaimed one (no ownership entry) does not.
    expect(windowChip("Owned Shell")).not.toBeNull();
    expect(windowChip("Unclaimed Shell")).toBeNull();
  });

  it("shows no chip at all with a single window (single-window users see no change)", async () => {
    // count stays 1 (default) — even though the ownership map has an entry.
    await renderModal();

    expect(windowChip("Owned Shell")).toBeNull();
    expect(windowChip("Unclaimed Shell")).toBeNull();
    expect(document.querySelectorAll("[data-testid='oc-row-window']")).toHaveLength(0);
  });
});
