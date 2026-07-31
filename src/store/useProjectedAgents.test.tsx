/**
 * `useProjectedAgents` — the agent sidebar & Open Connections cut to the projected
 * `agents` region (#2226 render cut). Drives the hook against an in-memory
 * substrate double and asserts: flag-off returns the appStore slice and dispatches
 * nothing; flag-on seeds the region (an `agent.replace` mirror) and then renders
 * the slice from the projection, value-identical to appStore; and a region that
 * has not caught up falls back to the appStore slice.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { useAppStore } from "@/store/appStore";
import type { RemoteAgentDefinition } from "@/types/connection";

import {
  AGENTS_REGION,
  setAgentRenderFromProjectionEnabled,
  setAgentTransportForTest,
  stopAgentsSubscription,
  type AgentsView,
} from "./agentsBridge";
import { useProjectedAgents } from "./useProjectedAgents";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

function agent(
  id: string,
  connectionState: RemoteAgentDefinition["connectionState"] = "disconnected"
): RemoteAgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    config: { host: `h-${id}`, port: 22, authMethod: "password" } as never,
    agentSettings: { autoReconnect: true } as never,
    isExpanded: false,
    connectionState,
  };
}

function session(id: string): AgentSessionInfo {
  return { sessionId: id, title: `s ${id}`, type: "shell", status: "running", attached: true };
}

function definition(id: string): AgentDefinitionInfo {
  return {
    id,
    name: `def ${id}`,
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
  };
}

function folder(id: string): AgentFolderInfo {
  return { id, name: `F ${id}`, parentId: null, isExpanded: true };
}

/** In-memory substrate double: applies `agent.replace` and fans a snapshot. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  /** When false, `agent.replace` acks but does NOT advance the region. */
  applyReplace = true;
  private view: Record<string, unknown> = {
    agents: [],
    sessions: {},
    definitions: {},
    folders: {},
  };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "agent.replace" && this.applyReplace) {
      const p = intent.payload as Record<string, unknown>;
      this.view = {
        agents: p.agents ?? [],
        sessions: p.sessions ?? {},
        definitions: p.definitions ?? {},
        folders: p.folders ?? {},
      };
      this.version += 1;
      this.fan();
    }
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: AGENTS_REGION, version: this.version }],
    };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.view) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(AGENTS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => AgentsView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: AgentsView = {
    remoteAgents: [],
    agentSessions: {},
    agentDefinitions: {},
    agentFolders: {},
  };

  function Probe() {
    latest = useProjectedAgents();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setAgentTransportForTest(transport);
  useAppStore.setState({
    remoteAgents: [],
    agentSessions: {},
    agentDefinitions: {},
    agentFolders: {},
  });
});

afterEach(() => {
  stopAgentsSubscription();
  setAgentTransportForTest(null);
  setAgentRenderFromProjectionEnabled(null);
});

const flush = () => act(async () => await Promise.resolve());

describe("useProjectedAgents", () => {
  it("flag off: returns the appStore slice and dispatches nothing", async () => {
    setAgentRenderFromProjectionEnabled(false);
    useAppStore.setState({
      remoteAgents: [agent("a1", "connected")],
      agentSessions: { a1: [session("s1")] },
    });

    const hook = renderHook();
    await flush();

    expect(hook.get().remoteAgents[0].connectionState).toBe("connected");
    expect(hook.get().agentSessions.a1).toHaveLength(1);
    expect(transport.dispatched).toHaveLength(0);
    hook.unmount();
  });

  it("flag on: seeds the region then renders the slice from the projection", async () => {
    const remoteAgents = [agent("a1", "connected")];
    const agentSessions = { a1: [session("s1")] };
    const agentDefinitions = { a1: [definition("d1")] };
    const agentFolders = { a1: [folder("f1")] };
    useAppStore.setState({ remoteAgents, agentSessions, agentDefinitions, agentFolders });

    const hook = renderHook();
    await flush();
    await flush();

    // The hook seeded appStore's slice via agent.replace…
    expect(transport.dispatched.some((d) => d.kind === "agent.replace")).toBe(true);
    // …and now renders a value-identical slice (sourced from the projection).
    expect(hook.get().remoteAgents).toEqual(remoteAgents);
    expect(hook.get().agentSessions).toEqual(agentSessions);
    expect(hook.get().agentDefinitions).toEqual(agentDefinitions);
    expect(hook.get().agentFolders).toEqual(agentFolders);
    hook.unmount();
  });

  it("region not caught up: falls back to the appStore slice", async () => {
    transport.applyReplace = false; // the replace acks but never advances the region
    const remoteAgents = [agent("a2", "reconnecting")];
    useAppStore.setState({ remoteAgents });

    const hook = renderHook();
    await flush();
    await flush();

    // The projection stays empty, so the gate rejects it and the hook renders the
    // appStore slice verbatim — parity preserved.
    expect(hook.get().remoteAgents).toEqual(remoteAgents);
    hook.unmount();
  });
});
