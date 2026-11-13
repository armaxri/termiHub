/**
 * Every terminal tab bound to a session that is already live must be listed in
 * the backend `session-lifecycle` region (#5645, follow-up to #5608).
 *
 * Such a tab never runs its own connect (no `session.connect`), and the backend
 * ignores `session.connected` for a tab it does not list — so before the fix
 * the tab had no live status and no reconnect after a drop. Each path below
 * opens a tab on a live session, then binds it the way the terminal does on
 * mount (`setTabSessionId`), and asserts the region got `session.connect`
 * followed by `session.connected`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api")>()),
  attachPersistentTab: vi.fn(() => Promise.resolve(1)),
  claimSession: vi.fn(() => Promise.resolve(null)),
  releaseSession: vi.fn(() => Promise.resolve(true)),
  sessionGetCapabilities: vi.fn(() => Promise.resolve({})),
}));

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { layoutState } from "@/test/layoutState";
import type { AgentDefinitionInfo } from "@/services/api";
import type { TabHandoffRecord } from "@/types/window";
import { getAllLeaves } from "@/utils/panelTree";

import { useAppStore } from "./appStore";
import {
  SESSION_LIFECYCLE_REGION,
  setSessionTransportForTest,
  stopSessionSubscription,
  type ProjectedSessionLifecycle,
} from "./sessionBridge";

setupConnectionsRegion();

/** A `session-lifecycle` double that folds `connect`/`connected`/`remove` like
 * the backend store (an unknown tab ignores `connected`) and records intents. */
class LifecycleTransport implements Transport {
  dispatched: Intent[] = [];
  sessions: Record<string, ProjectedSessionLifecycle> = {};
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    const id = (intent.payload as { sessionId?: string }).sessionId ?? "";
    if (intent.kind === "session.connect") {
      this.sessions[id] = lifecycle("connecting");
    } else if (intent.kind === "session.connected" && this.sessions[id]) {
      this.sessions[id] = lifecycle("connected");
    } else if (intent.kind === "session.remove") {
      delete this.sessions[id];
    }
    this.version += 1;
    const frame: ProjectionFrame = this.snapshot(SESSION_LIFECYCLE_REGION);
    for (const h of this.handlers) h(frame);
    return {
      intentId: intent.intentId,
      status: "accepted",
      produced: [{ region: SESSION_LIFECYCLE_REGION, version: this.version }],
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

  /** The `session.*` intents dispatched for `tabId`, in order. */
  kindsFor(tabId: string): string[] {
    return this.dispatched
      .filter((i) => (i.payload as { sessionId?: string }).sessionId === tabId)
      .map((i) => i.kind);
  }

  private snapshot(region: string): SnapshotFrame {
    return {
      kind: "snapshot",
      region,
      version: this.version,
      view: { sessions: structuredClone(this.sessions) },
    };
  }
}

function lifecycle(status: "connecting" | "connected"): ProjectedSessionLifecycle {
  return {
    status,
    reconnect: { phase: "idle", attempt: 0, nextAttemptAt: null },
  } as unknown as ProjectedSessionLifecycle;
}

let transport: LifecycleTransport;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function allTabs() {
  return getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs);
}

function activeLeafId(): string {
  return getAllLeaves(layoutState().rootPanel)[0].id;
}

/** Bind the tab to its session the way the terminal does once it attaches. */
async function bindLikeTerminal(tabId: string, sessionId: string): Promise<void> {
  useAppStore.getState().setTabSessionId(tabId, sessionId);
  await flush();
  await flush();
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  transport = new LifecycleTransport();
  setSessionTransportForTest(transport);
});

afterEach(() => {
  stopSessionSubscription();
  setSessionTransportForTest(null);
});

describe("tabs opened on an already-live session register in the region (#5645)", () => {
  it("the agent setup terminal (AgentSetupDialog)", async () => {
    // The dialog opens the setup terminal on the SSH session setup_remote_agent made.
    const tabId = useAppStore
      .getState()
      .addTab(
        "Setup: box",
        "ssh",
        { type: "ssh", config: { host: "box", port: 22, username: "ops" } },
        { contentType: "terminal", sessionId: "sess-setup" }
      );
    await bindLikeTerminal(tabId, "sess-setup");

    expect(transport.kindsFor(tabId)).toEqual(["session.connect", "session.connected"]);
    expect(transport.sessions[tabId]?.status).toBe("connected");
  });

  it("a saved connection opened on its pre-connected session", async () => {
    // connectSavedConnection opens the tab with the pre-connect's session id.
    const tabId = useAppStore
      .getState()
      .addTab(
        "web-1",
        "ssh",
        { type: "ssh", config: { host: "h", username: "ops", authMethod: "password" } },
        { connectionId: "conn-1", sessionId: "sess-pre" }
      );
    await bindLikeTerminal(tabId, "sess-pre");

    expect(transport.kindsFor(tabId)).toEqual(["session.connect", "session.connected"]);
  });

  it("a persistent session attached in a new tab", async () => {
    seedConnectionsRegion({
      connections: [
        {
          id: "conn-p",
          name: "persistent",
          folderId: null,
          config: { type: "local", config: { shell: "bash" } },
        },
      ],
    });
    useAppStore.setState({
      persistentSessions: {
        "conn-p": {
          connectionId: "conn-p",
          sessionId: "sess-p",
          state: "running",
          attachedTabIds: [],
        },
      },
    });
    await useAppStore.getState().attachPersistentSession("conn-p", activeLeafId());
    const tab = allTabs().find((t) => t.sessionId === "sess-p");
    expect(tab).toBeDefined();
    await bindLikeTerminal(tab!.id, "sess-p");

    expect(transport.kindsFor(tab!.id)).toEqual(["session.connect", "session.connected"]);
  });

  it("an agent persistent session attached in a new tab", async () => {
    const def: AgentDefinitionInfo = {
      id: "def-1",
      name: "Persistent Shell",
      sessionType: "shell",
      config: { shell: "/bin/bash" },
      persistent: true,
      folderId: null,
    };
    useAppStore.setState({
      persistentSessions: {
        "agent-1:def-1": {
          connectionId: "agent-1:def-1",
          sessionId: "sess-agent",
          state: "running",
          attachedTabIds: [],
        },
      },
    });
    await useAppStore.getState().attachAgentPersistentSession("agent-1", def, activeLeafId());
    const tab = allTabs().find((t) => t.sessionId === "sess-agent");
    expect(tab).toBeDefined();
    await bindLikeTerminal(tab!.id, "sess-agent");

    expect(transport.kindsFor(tab!.id)).toEqual(["session.connect", "session.connected"]);
  });

  it("a tab moved in from another window (new tab id)", async () => {
    const record: TabHandoffRecord = {
      tab: {
        sessionId: "sess-moved",
        title: "moved",
        connectionType: "local",
        contentType: "terminal",
        config: { type: "local", config: {} },
      },
    };
    useAppStore.getState().hydrateHandoffTab(record);
    const tab = allTabs().find((t) => t.sessionId === "sess-moved");
    expect(tab).toBeDefined();
    await bindLikeTerminal(tab!.id, "sess-moved");

    expect(transport.kindsFor(tab!.id)).toEqual(["session.connect", "session.connected"]);
  });
});

describe("binding a tab the region already lists (#5645)", () => {
  it("only settles it connected — never resets it with a fresh connect", async () => {
    const tabId = useAppStore.getState().addTab("bash", "local");
    // The terminal's own connect registered it (fresh create path).
    useAppStore.getState().setTerminalConnecting(tabId, true);
    await flush();
    await bindLikeTerminal(tabId, "sess-own");

    expect(transport.kindsFor(tabId)).toEqual(["session.connect", "session.connected"]);
    expect(transport.sessions[tabId]?.status).toBe("connected");
  });

  it("registers once even when bound twice before the first is acknowledged", async () => {
    const tabId = useAppStore
      .getState()
      .addTab(
        "Setup: box",
        "ssh",
        { type: "ssh", config: { host: "box", port: 22, username: "ops" } },
        { contentType: "terminal", sessionId: "sess-twice" }
      );
    useAppStore.getState().setTabSessionId(tabId, "sess-twice");
    useAppStore.getState().setTabSessionId(tabId, "sess-twice");
    await flush();
    await flush();

    expect(transport.kindsFor(tabId)).toEqual(["session.connect", "session.connected"]);
  });

  it("leaves non-terminal tabs out of the region", async () => {
    const tabId = useAppStore
      .getState()
      .addTab(
        "files",
        "sftp",
        { type: "sftp", config: { host: "h" } },
        { contentType: "file-browser", sessionId: "sess-fb" }
      );
    await bindLikeTerminal(tabId, "sess-fb");

    expect(transport.kindsFor(tabId)).not.toContain("session.connect");
  });
});
