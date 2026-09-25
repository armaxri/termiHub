import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { RemoteAgentDefinition } from "@/types/connection";
import { setNetworkToolRunLocation } from "@/services/networkApi";
import { useRunLocationStore } from "@/store/runLocationStore";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { NetworkToolRunLocation } from "./NetworkToolRunLocation";
import { HTTP_MONITOR_AGENT_REASON } from "./networkToolLocation";

// Replace the Radix-backed selector with a trivial harness so the wiring
// (backend call + optimistic store update + desktop-only gating) can be tested
// without driving Radix's portal/pointer machinery in jsdom.
vi.mock("@/components/RunLocationSelect", () => ({
  RunLocationSelect: ({
    value,
    agentAllowed,
    onChange,
    ...rest
  }: {
    value: { kind: string; agentId?: string };
    agentAllowed?: boolean;
    onChange: (loc: { kind: string; agentId?: string }) => void;
    "data-testid"?: string;
  }) => (
    <div
      data-testid={rest["data-testid"]}
      data-agent-allowed={String(agentAllowed !== false)}
      data-value={value.kind === "agent" ? `agent:${value.agentId}` : "this"}
    >
      <button data-testid="pick-agent" onClick={() => onChange({ kind: "agent", agentId: "a1" })}>
        agent
      </button>
      <button data-testid="pick-this" onClick={() => onChange({ kind: "thisComputer" })}>
        this
      </button>
    </div>
  ),
}));

vi.mock("@/services/networkApi", () => ({
  setNetworkToolRunLocation: vi.fn(() => Promise.resolve()),
}));

function agent(id: string, name: string): RemoteAgentDefinition {
  return {
    id,
    name,
    config: {} as RemoteAgentDefinition["config"],
    agentSettings: {} as RemoteAgentDefinition["agentSettings"],
    isExpanded: false,
    connectionState: "connected",
  };
}

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

setupAgentsRegion();

describe("NetworkToolRunLocation", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    seedAgentsRegion({ remoteAgents: [agent("a1", "build-server")] });
    useRunLocationStore.setState({ networkToolLocations: {}, serverLocations: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("routes a network tool to an agent and mirrors the choice (persistence)", async () => {
    render(<NetworkToolRunLocation tool="ping" />);
    const control = document.querySelector('[data-testid="network-runloc-ping"]') as HTMLElement;
    expect(control.getAttribute("data-agent-allowed")).toBe("true");
    expect(control.getAttribute("data-value")).toBe("this");

    act(() => {
      (document.querySelector('[data-testid="pick-agent"]') as HTMLButtonElement).click();
    });
    await flush();

    // Persisted on the backend under the tool's backend key…
    expect(setNetworkToolRunLocation).toHaveBeenCalledWith("ping", {
      kind: "agent",
      agentId: "a1",
    });
    // …and mirrored in the store, so the selector keeps showing the agent.
    expect(useRunLocationStore.getState().networkToolLocations.ping).toEqual({
      kind: "agent",
      agentId: "a1",
    });
    expect(
      (document.querySelector('[data-testid="network-runloc-ping"]') as HTMLElement).getAttribute(
        "data-value"
      )
    ).toBe("agent:a1");
  });

  it("maps the port scanner to its backend key", async () => {
    render(<NetworkToolRunLocation tool="port-scanner" />);
    act(() => {
      (document.querySelector('[data-testid="pick-agent"]') as HTMLButtonElement).click();
    });
    await flush();
    expect(setNetworkToolRunLocation).toHaveBeenCalledWith("port_scan", {
      kind: "agent",
      agentId: "a1",
    });
  });

  it("gates the agent option for the desktop-only HTTP monitor and says why", () => {
    render(<NetworkToolRunLocation tool="http-monitor" />);
    const control = document.querySelector(
      '[data-testid="network-runloc-http-monitor"]'
    ) as HTMLElement;
    expect(control.getAttribute("data-agent-allowed")).toBe("false");
    // PROD-033: the disabled control carries a visible reason + tooltip that
    // points at the per-monitor "Run on" field.
    const reason = document.querySelector(
      '[data-testid="network-runloc-reason-http-monitor"]'
    ) as HTMLElement;
    expect(reason).not.toBeNull();
    expect(reason.textContent).toBe(HTTP_MONITOR_AGENT_REASON);
    expect(reason.parentElement?.getAttribute("title")).toBe(HTTP_MONITOR_AGENT_REASON);
  });

  it.each([
    ["ping-sweep", "ping_sweep"],
    ["open-ports", "open_ports"],
  ] as const)(
    "offers an agent for %s and routes it under backend key %s (PROD-033)",
    async (tool, backendKey) => {
      render(<NetworkToolRunLocation tool={tool} />);
      const control = document.querySelector(
        `[data-testid="network-runloc-${tool}"]`
      ) as HTMLElement;
      expect(control.getAttribute("data-agent-allowed")).toBe("true");
      // An agent-routable tool shows no "why not" reason.
      expect(document.querySelector(`[data-testid="network-runloc-reason-${tool}"]`)).toBeNull();
      expect(control.parentElement?.getAttribute("title")).toBeNull();

      act(() => {
        (document.querySelector('[data-testid="pick-agent"]') as HTMLButtonElement).click();
      });
      await flush();
      expect(setNetworkToolRunLocation).toHaveBeenCalledWith(backendKey, {
        kind: "agent",
        agentId: "a1",
      });
      expect(useRunLocationStore.getState().networkToolLocations[tool]).toEqual({
        kind: "agent",
        agentId: "a1",
      });
    }
  );

  it("rolls back the mirrored choice when the backend rejects it", async () => {
    (setNetworkToolRunLocation as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("agent unavailable")
    );
    render(<NetworkToolRunLocation tool="ping" />);
    act(() => {
      (document.querySelector('[data-testid="pick-agent"]') as HTMLButtonElement).click();
    });
    await flush();
    // The optimistic update is reverted to the This-computer default.
    expect(useRunLocationStore.getState().networkToolLocations.ping).toEqual({
      kind: "thisComputer",
    });
  });
});
