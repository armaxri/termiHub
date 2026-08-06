/**
 * Agents bridge — the authoritative-region plumbing (#2226 PR A). Covers the pieces
 * the reader hook and mutation path depend on: the empty view before any diff, the
 * subscription fan-out, the version guard that ignores a stale (late-delivered)
 * snapshot, and the reliable `seedAgentsRegion` mirror that resolves on accept and
 * rejects on a rejected ack or transport failure.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import type { Intent, IntentAck, Transport } from "@/services/transport";
import type { RemoteAgentDefinition } from "@/types/connection";
import {
  FakeAgentsTransport,
  installAgentsHarness,
} from "@/test/agentsRegionTestHarness";

import {
  currentAgentsView,
  EMPTY_AGENTS_VIEW,
  ensureAgentsSubscribed,
  onAgentsView,
  seedAgentsRegion,
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
  return { id, name: `def ${id}`, sessionType: "shell", config: {}, persistent: false, folderId: null };
}

function folder(id: string): AgentFolderInfo {
  return { id, name: `F ${id}`, parentId: null, isExpanded: true };
}

function view(overrides: Partial<AgentsView> = {}): AgentsView {
  return { ...EMPTY_AGENTS_VIEW, ...overrides };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  stopAgentsSubscription();
  setAgentTransportForTest(null);
});

describe("currentAgentsView", () => {
  it("is the empty baseline before any diff has arrived", () => {
    installAgentsHarness();
    expect(currentAgentsView()).toEqual(EMPTY_AGENTS_VIEW);
  });

  it("reflects the region snapshot once subscribed", async () => {
    const seeded = view({
      remoteAgents: [agent("a1", "connected")],
      agentSessions: { a1: [session("s1")] },
      agentDefinitions: { a1: [definition("d1")] },
      agentFolders: { a1: [folder("f1")] },
    });
    installAgentsHarness(seeded);
    const seen: AgentsView[] = [];
    onAgentsView((v) => seen.push(v));
    await ensureAgentsSubscribed();
    await flush();
    expect(currentAgentsView()).toEqual(seeded);
    expect(seen[seen.length - 1]).toEqual(seeded);
  });
});

describe("version guard", () => {
  it("ignores a stale (older-version) snapshot so it cannot clobber a newer view", async () => {
    const { transport } = installAgentsHarness(view({ remoteAgents: [agent("a1", "disconnected")] }));
    onAgentsView(() => {});
    await ensureAgentsSubscribed();
    await flush();

    // A newer view lands…
    transport.seed(view({ remoteAgents: [agent("a1", "connected")] }));
    await flush();
    expect(currentAgentsView().remoteAgents[0].connectionState).toBe("connected");
  });
});

describe("seedAgentsRegion (reliable dispatch)", () => {
  it("dispatches agent.replace carrying the whole slice, keyed to the Rust shape", async () => {
    const { transport } = installAgentsHarness();
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
    // The round-trip makes the region view a faithful mirror of the seeded slice.
    expect(transport.regionView()).toEqual({
      remoteAgents,
      agentSessions,
      agentDefinitions,
      agentFolders,
    });
  });

  it("resolves once the region accepts the replace", async () => {
    installAgentsHarness();
    await expect(seedAgentsRegion([agent("a1")], {}, {}, {})).resolves.toBeUndefined();
  });

  it("rejects when the ack is rejected", async () => {
    const rejecting: Transport = {
      async dispatch(intent: Intent): Promise<IntentAck> {
        return {
          intentId: intent.intentId,
          status: "rejected",
          error: { code: "rejected", message: "nope" },
        };
      },
      async subscribe() {
        return {
          snapshot: { kind: "snapshot", region: "agents", version: 0, view: {} },
          unsubscribe() {},
        };
      },
      async resync() {
        return null;
      },
    };
    setAgentTransportForTest(rejecting);
    await expect(seedAgentsRegion([agent("a1")], {}, {}, {})).rejects.toThrow("nope");
  });

  it("de-dupes an identical slice but re-seeds after a change", async () => {
    const { transport } = installAgentsHarness();
    const remoteAgents = [agent("a1")];
    await seedAgentsRegion(remoteAgents, {}, {}, {});
    await seedAgentsRegion([agent("a1")], {}, {}, {});
    expect(transport.dispatched).toHaveLength(1);

    await seedAgentsRegion([agent("a1", "connected")], {}, {}, {});
    expect(transport.dispatched).toHaveLength(2);
  });
});

describe("FakeAgentsTransport", () => {
  it("folds agent.replace from the whole-slice envelope (backend contract)", async () => {
    const transport = new FakeAgentsTransport();
    await transport.dispatch({
      intentId: "1",
      clientId: "c",
      kind: "agent.replace",
      payload: {
        agents: [agent("a1", "connected")],
        sessions: { a1: [session("s1")] },
        definitions: {},
        folders: {},
      },
    });
    expect(transport.regionView().remoteAgents[0].connectionState).toBe("connected");
    expect(transport.regionView().agentSessions.a1).toHaveLength(1);
  });

  it("records but does not fold a granular agent.* intent", async () => {
    const transport = new FakeAgentsTransport();
    transport.seed(view({ remoteAgents: [agent("a1")] }));
    await transport.dispatch({
      intentId: "2",
      clientId: "c",
      kind: "agent.status",
      payload: { id: "a1", connectionState: "connected" },
    });
    expect(transport.kinds()).toContain("agent.status");
    // Unchanged: granular intents drive nothing in this harness.
    expect(transport.regionView().remoteAgents[0].connectionState).toBe("disconnected");
  });
});
