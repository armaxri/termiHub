/**
 * Regression tests for the agent-session load path of the Open Connections
 * panel (WA-FE-011). `loadData` used to depend on a hand-built joined-id key to
 * avoid recreating on every render; it now depends on a memoized
 * `connectedAgents` list. These tests pin the observable behaviour that change
 * must preserve: opening the panel fetches each connected agent's sessions
 * exactly once, and a plain parent re-render does not re-fetch (no loop / no
 * spurious refire).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";

const listAgentSessions = vi.fn((_id: string) => Promise.resolve([]));

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: (id: string) => listAgentSessions(id),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve(true)),
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
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

function agent(id: string, name: string): RemoteAgentDefinition {
  return {
    id,
    name,
    type: "remote-agent",
    connectionState: "connected",
    isExpanded: false,
    config: { host: "h", port: 22, username: "u", authMethod: "password" },
  } as unknown as RemoteAgentDefinition;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

setupAgentsRegion();

describe("OpenConnectionsModal — agent session load (WA-FE-011)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    listAgentSessions.mockClear();
    listAgentSessions.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(open: boolean) {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={open} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  it("fetches each connected agent's sessions exactly once on open", async () => {
    seedAgentsRegion({ remoteAgents: [agent("a1", "build-box"), agent("a2", "nas")] });
    render(true);
    await flush();
    expect(listAgentSessions).toHaveBeenCalledWith("a1");
    expect(listAgentSessions).toHaveBeenCalledWith("a2");
    // One fetch per agent — the load ran once, not in a loop.
    expect(listAgentSessions).toHaveBeenCalledTimes(2);
  });

  it("does not re-fetch on a plain parent re-render (loadData stays stable)", async () => {
    seedAgentsRegion({ remoteAgents: [agent("a1", "build-box")] });
    render(true);
    await flush();
    expect(listAgentSessions).toHaveBeenCalledTimes(1);

    // Re-render with identical props + unchanged store. The `[open]` effect must
    // not refire and the memoized `connectedAgents` must keep `loadData` stable,
    // so no additional fetch happens.
    render(true);
    await flush();
    expect(listAgentSessions).toHaveBeenCalledTimes(1);
  });

  it("does not fetch agent sessions while the panel is closed", async () => {
    seedAgentsRegion({ remoteAgents: [agent("a1", "build-box")] });
    render(false);
    await flush();
    expect(listAgentSessions).not.toHaveBeenCalled();
  });
});
