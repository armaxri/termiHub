/**
 * Tests for the "Establishing / recovering" section of the Open Connections
 * panel (G2, #1235): agents still connecting or reconnecting are now visible
 * and killable. Connecting → cancel_connect_agent aborts the handshake;
 * reconnecting → disconnect ends the backoff loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";

const cancelConnectAgent = vi.fn((_id: string) => Promise.resolve(true));
const disconnectAgent = vi.fn((_id: string) => Promise.resolve());

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: (id: string) => cancelConnectAgent(id),
  disconnectAgent: (id: string) => disconnectAgent(id),
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
import { setupAgentsRegionMirror } from "@/test/agentsRegionTestHarness";

function agent(
  id: string,
  name: string,
  connectionState: RemoteAgentDefinition["connectionState"]
): RemoteAgentDefinition {
  return {
    id,
    name,
    type: "remote-agent",
    connectionState,
    isExpanded: false,
    config: {
      host: "h",
      port: 22,
      username: "u",
      authMethod: "password",
    },
  } as unknown as RemoteAgentDefinition;
}

setupAgentsRegionMirror();

describe("OpenConnectionsModal — Establishing / recovering section", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    cancelConnectAgent.mockClear();
    disconnectAgent.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWithAgents(agents: RemoteAgentDefinition[]) {
    useAppStore.setState({ remoteAgents: agents });
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  function rowFor(title: string): Element | undefined {
    return Array.from(document.querySelectorAll(".oc-row")).find((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes(title)
    );
  }

  it("lists a connecting agent and cancels it via cancel_connect_agent", () => {
    renderWithAgents([agent("a1", "build-box", "connecting")]);

    const row = rowFor("build-box");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".oc-row__badge--connecting")).toBeTruthy();

    const killBtn = row?.querySelector(".oc-row__kill") as HTMLButtonElement;
    act(() => killBtn.click());
    expect(cancelConnectAgent).toHaveBeenCalledWith("a1");
  });

  it("lists a reconnecting agent and kills it via disconnect", () => {
    renderWithAgents([agent("a2", "edge-node", "reconnecting")]);

    const row = rowFor("edge-node");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".oc-row__badge--reconnecting")).toBeTruthy();

    const killBtn = row?.querySelector(".oc-row__kill") as HTMLButtonElement;
    act(() => killBtn.click());
    expect(disconnectAgent).toHaveBeenCalledWith("a2");
  });

  it("shows no Establishing section when no agent is connecting/reconnecting", () => {
    renderWithAgents([agent("a3", "ready", "connected")]);
    const titles = Array.from(document.querySelectorAll(".oc-section__title")).map(
      (t) => t.textContent
    );
    expect(titles).not.toContain("Establishing / recovering");
  });
});
