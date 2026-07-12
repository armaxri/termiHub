/**
 * Tests for the "Spawned Containers" section of the Open Connections panel
 * (#1446): spawned containers (opened from a CLI/context-menu spawn, no saved
 * connection id) are tracked separately from configured Docker connections and
 * are not double-listed under "Local Sessions".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { TerminalTab } from "@/types/terminal";

const closeTerminal = vi.fn((_id: string) => Promise.resolve());
vi.mock("@/services/api", () => ({
  listLocalSessions: vi.fn(() =>
    Promise.resolve([
      {
        id: "sess-spawn",
        title: "Container: alpine:3 (Spawned)",
        connectionType: "docker",
        alive: true,
      },
      { id: "sess-plain", title: "My Shell", connectionType: "local", alive: true },
    ])
  ),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: (id: string) => closeTerminal(id),
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

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function spawnedTab(id: string, title: string, sessionId: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId,
    title,
    connectionType: "docker",
    contentType: "terminal",
    config: { type: "docker", config: {} },
    panelId,
    isActive: true,
    spawned: true,
  };
}

describe("OpenConnectionsModal — Spawned Containers section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    closeTerminal.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderWithSpawnedTab() {
    const leafId = useAppStore.getState().rootPanel.id;
    const tab = spawnedTab("tab-1", "Container: alpine:3 (Spawned)", "sess-spawn", leafId);
    useAppStore.setState({
      rootPanel: { type: "leaf", id: leafId, tabs: [tab], activeTabId: tab.id },
      activePanelId: leafId,
    });
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

  it("lists the spawned container in its own section", async () => {
    await renderWithSpawnedTab();
    const titles = Array.from(document.querySelectorAll(".oc-section__title")).map(
      (t) => t.textContent
    );
    expect(titles).toContain("Spawned Containers");

    const rows = Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes("Container: alpine:3")
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("does not double-list the spawned session under Local Sessions", async () => {
    await renderWithSpawnedTab();
    // Exactly one row mentions the spawned container — it lives in its own
    // section, not also under Local Sessions.
    const spawnedRows = Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes("Container: alpine:3")
    );
    expect(spawnedRows).toHaveLength(1);
    // The plain local session is still listed.
    const plainRows = Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes("My Shell")
    );
    expect(plainRows).toHaveLength(1);
  });

  it("kills a spawned container via close_terminal", async () => {
    await renderWithSpawnedTab();
    const row = Array.from(document.querySelectorAll(".oc-row")).find((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes("Container: alpine:3")
    );
    const killBtn = row?.querySelector(".oc-row__kill") as HTMLButtonElement;
    expect(killBtn).not.toBeNull();
    await act(async () => {
      killBtn.click();
      await Promise.resolve();
    });
    expect(closeTerminal).toHaveBeenCalledWith("sess-spawn");
  });
});
