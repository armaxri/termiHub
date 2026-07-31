import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import type { RemoteAgentDefinition } from "@/types/connection";

import {
  AGENTS_REGION,
  agentRenderFromProjectionEnabled,
  agentsViewMirrors,
  currentAgentsView,
  deepEqual,
  ensureAgentsSubscribed,
  onAgentsView,
  seedAgentsRegion,
  setAgentRenderFromProjectionEnabled,
  setAgentTransportForTest,
  stopAgentsSubscription,
  type AgentsView,
} from "./agentsBridge";

/** A deterministic remote-agent definition. */
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

/**
 * An in-memory substrate double: holds one `agents` view, applies an
 * `agent.replace` intent by overwriting the view from its payload (keyed to the
 * Rust snapshot shape `agents/sessions/definitions/folders`), and fans a fresh
 * snapshot to every subscriber — so the seed round-trip and multi-subscriber
 * fan-out are exercised without a backend.
 */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
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
    if (intent.kind === "agent.replace") {
      const p = intent.payload as Record<string, unknown>;
      this.view = {
        agents: p.agents ?? [],
        sessions: p.sessions ?? {},
        definitions: p.definitions ?? {},
        folders: p.folders ?? {},
      };
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: AGENTS_REGION, version: this.version }],
      };
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
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

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setAgentTransportForTest(transport);
});

afterEach(() => {
  stopAgentsSubscription();
  setAgentTransportForTest(null);
  setAgentRenderFromProjectionEnabled(null);
});

describe("agentRenderFromProjectionEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(agentRenderFromProjectionEnabled()).toBe(true);
    setAgentRenderFromProjectionEnabled(false);
    expect(agentRenderFromProjectionEnabled()).toBe(false);
    setAgentRenderFromProjectionEnabled(true);
    expect(agentRenderFromProjectionEnabled()).toBe(true);
    setAgentRenderFromProjectionEnabled(null);
    expect(agentRenderFromProjectionEnabled()).toBe(true);
  });
});

describe("deepEqual", () => {
  it("treats an integer and its float round-trip as equal", () => {
    expect(deepEqual(40, 40.0)).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
  });

  it("distinguishes differing values, key sets, and null", () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });
});

describe("agentsViewMirrors", () => {
  const remoteAgents = [agent("a1", "connected")];
  const agentSessions = { a1: [session("s1")] };
  const agentDefinitions = { a1: [definition("d1")] };
  const agentFolders = { a1: [folder("f1")] };

  it("is false for an undefined view", () => {
    expect(
      agentsViewMirrors(undefined, remoteAgents, agentSessions, agentDefinitions, agentFolders)
    ).toBe(false);
  });

  it("is true when the view value-matches the appStore slice", () => {
    const view: AgentsView = {
      remoteAgents: structuredClone(remoteAgents),
      agentSessions: structuredClone(agentSessions),
      agentDefinitions: structuredClone(agentDefinitions),
      agentFolders: structuredClone(agentFolders),
    };
    expect(
      agentsViewMirrors(view, remoteAgents, agentSessions, agentDefinitions, agentFolders)
    ).toBe(true);
  });

  it("is false when the connection status diverges", () => {
    const view: AgentsView = {
      remoteAgents: [{ ...remoteAgents[0], connectionState: "disconnected" }],
      agentSessions,
      agentDefinitions,
      agentFolders,
    };
    expect(
      agentsViewMirrors(view, remoteAgents, agentSessions, agentDefinitions, agentFolders)
    ).toBe(false);
  });

  it("is false when a per-agent sub-map diverges", () => {
    const view: AgentsView = {
      remoteAgents,
      agentSessions: { a1: [session("s1"), session("s2")] },
      agentDefinitions,
      agentFolders,
    };
    expect(
      agentsViewMirrors(view, remoteAgents, agentSessions, agentDefinitions, agentFolders)
    ).toBe(false);
  });

  it("is false when the agent list order diverges", () => {
    const twoAgents = [agent("a1", "connected"), agent("a2")];
    const reversed = [agent("a2"), agent("a1", "connected")];
    const view: AgentsView = {
      remoteAgents: reversed,
      agentSessions: {},
      agentDefinitions: {},
      agentFolders: {},
    };
    expect(agentsViewMirrors(view, twoAgents, {}, {}, {})).toBe(false);
  });
});

describe("seedAgentsRegion", () => {
  it("dispatches agent.replace carrying the whole slice, keyed to the Rust shape", async () => {
    const remoteAgents = [agent("a1", "connected")];
    const agentSessions = { a1: [session("s1")] };
    const agentDefinitions = { a1: [definition("d1")] };
    const agentFolders = { a1: [folder("f1")] };
    await seedAgentsRegion(remoteAgents, agentSessions, agentDefinitions, agentFolders);
    expect(transport.dispatched).toHaveLength(1);
    expect(transport.dispatched[0]).toMatchObject({
      kind: "agent.replace",
      payload: {
        agents: remoteAgents,
        sessions: agentSessions,
        definitions: agentDefinitions,
        folders: agentFolders,
      },
    });
  });

  it("de-dupes an identical slice but re-seeds after a change", async () => {
    const remoteAgents = [agent("a1")];
    await seedAgentsRegion(remoteAgents, {}, {}, {});
    await seedAgentsRegion(remoteAgents, {}, {}, {});
    expect(transport.dispatched).toHaveLength(1);

    const changed = [agent("a1", "connected")];
    await seedAgentsRegion(changed, {}, {}, {});
    expect(transport.dispatched).toHaveLength(2);
  });
});

describe("seed round-trip → the region mirrors appStore", () => {
  it("makes the projected view a faithful mirror of the seeded slice", async () => {
    const received: AgentsView[] = [];
    const unsubscribe = onAgentsView((v) => received.push(v));
    await ensureAgentsSubscribed();

    const remoteAgents = [agent("a1", "connected")];
    const agentSessions = { a1: [session("s1")] };
    const agentDefinitions = { a1: [definition("d1")] };
    const agentFolders = { a1: [folder("f1")] };
    await seedAgentsRegion(remoteAgents, agentSessions, agentDefinitions, agentFolders);

    // The region now carries the seeded slice and the gate accepts it.
    expect(
      agentsViewMirrors(
        currentAgentsView(),
        remoteAgents,
        agentSessions,
        agentDefinitions,
        agentFolders
      )
    ).toBe(true);
    expect(received[received.length - 1]).toEqual({
      remoteAgents,
      agentSessions,
      agentDefinitions,
      agentFolders,
    });
    unsubscribe();
  });
});
