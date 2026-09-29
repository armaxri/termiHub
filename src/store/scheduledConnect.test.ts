/**
 * "Connect if not connected" for scheduled runs (#3527): the connecting window
 * connects only the targets with no connected terminal, runs on them, and
 * closes exactly the tabs it opened — on success and on failure — while tabs
 * that were already open stay. A target the unattended connect refuses is
 * skipped with its reason in the window's report. Without the opt-in nothing
 * is connected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], fileBrowserEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/macroApi", () => ({
  listMacros: vi.fn(() => Promise.resolve([])),
  getMacro: vi.fn(),
  saveMacro: vi.fn((m: unknown) => Promise.resolve(m)),
  deleteMacro: vi.fn(() => Promise.resolve()),
  listMacroRuns: vi.fn(() => Promise.resolve([])),
  recordMacroRun: vi.fn(() => Promise.resolve([])),
  clearMacroRunHistory: vi.fn(() => Promise.resolve([])),
}));

import type { SavedConnection } from "@/types/connection";
import type { Macro } from "@/types/macro";
import type { ScheduleFire } from "@/types/schedule";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import {
  registerTerminalInputInjector,
  registerTerminalReadyProbe,
} from "@/services/macroPlayback";
import { seedConnectionsRegion, setupConnectionsRegion } from "@/test/connectionsHarness";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { installSessionLifecycleHarness } from "@/test/sessionLifecycleRegionTestHarness";
import { useAppStore } from "./appStore";
import { claimedTargetIds, executeScheduledRun } from "./scheduledRuns";
import { awaitRunCoverage, type UnattendedConnector } from "./scheduledConnect";

setupConnectionsRegion();

const store = { getState: useAppStore.getState, setState: useAppStore.setState };

function saved(id: string): SavedConnection {
  return {
    id,
    name: `Host ${id}`,
    folderId: null,
    config: { type: "ssh", config: { host: `${id}.example`, username: "u", authMethod: "key" } },
  };
}

const macro: Macro = {
  id: "m1",
  name: "Uptime",
  tags: [],
  steps: [{ data: "uptime\n", delayMs: 0 }],
  createdAt: "",
  updatedAt: "",
};

function fire(connectionIds: string[]): ScheduleFire {
  return {
    token: "tok",
    scheduleId: "sch",
    scheduleName: "Health",
    action: { kind: "macro", macroId: "m1" },
    targets: { kind: "connections", connectionIds },
    catchUp: false,
    connectWindow: "main",
  };
}

/** A connector double that opens a tab on a fresh session, like the real flow. */
function openingConnector(): UnattendedConnector & { calls: string[] } {
  const calls: string[] = [];
  const connector = async (connection: SavedConnection) => {
    calls.push(connection.id);
    const sessionId = `sess-new-${connection.id}`;
    const tabId = useAppStore.getState().addTab(connection.name, "ssh", connection.config, {
      connectionId: connection.id,
      sessionId,
    });
    return { status: "opened" as const, tabId, sessionId };
  };
  return Object.assign(connector, { calls });
}

function liveTabIds(): string[] {
  const root = layoutState().rootPanel;
  return root.type === "leaf" ? root.tabs.map((t) => t.id) : [];
}

describe("scheduled runs — connect if not connected (#3527)", () => {
  installSessionLifecycleHarness();
  let injected: { tabId: string; data: string }[];

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    injected = [];
    registerTerminalInputInjector(async (tabId, data) => {
      injected.push({ tabId, data });
      return true;
    });
    // An already-open, connected tab of conn-a (the user's own).
    const tab: TerminalTab = {
      id: "tab-user-a",
      sessionId: "sess-user-a",
      title: "Host a",
      connectionType: "ssh",
      contentType: "terminal",
      config: { type: "ssh", config: {} },
      panelId: "leaf-1",
      isActive: true,
      connectionId: "conn-a",
    };
    const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: tab.id };
    seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
    seedConnectionsRegion({ connections: [saved("conn-a"), saved("conn-b"), saved("conn-c")] });
    useAppStore.setState({ macros: [macro] });
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    registerTerminalReadyProbe(null);
    vi.restoreAllMocks();
  });

  it("is off by default: a window that is not the connect window connects nothing", async () => {
    const report = await executeScheduledRun(fire(["conn-a", "conn-b"]), store, {
      connectMissing: undefined,
    });

    expect(liveTabIds()).toEqual(["tab-user-a"]);
    expect(report).toMatchObject({ outcome: "completed", targetsRun: 1 });
    expect(injected.map((i) => i.tabId)).toEqual(["tab-user-a"]);
  });

  it("connects only missing targets, runs on them, then closes only the tabs it opened", async () => {
    const connector = openingConnector();

    const report = await executeScheduledRun(fire(["conn-a", "conn-b"]), store, {
      connectMissing: connector,
    });

    // conn-a was already connected; only conn-b is connected unattended.
    expect(connector.calls).toEqual(["conn-b"]);
    expect(report).toMatchObject({ outcome: "completed", targetsRun: 2 });
    expect(injected).toHaveLength(2);
    expect(injected.some((i) => i.tabId === "tab-user-a")).toBe(true);
    // The opened tab is gone again; the user's tab stays.
    expect(liveTabIds()).toEqual(["tab-user-a"]);
  });

  it("records each refused target's reason and still runs on the rest", async () => {
    const connector: UnattendedConnector = async (connection) =>
      connection.id === "conn-b"
        ? { status: "refused", reason: "needs a password" }
        : { status: "refused", reason: "host key not trusted" };

    const report = await executeScheduledRun(fire(["conn-a", "conn-b", "conn-c"]), store, {
      connectMissing: connector,
    });

    expect(report.outcome).toBe("completed");
    expect(report.targetsRun).toBe(1);
    expect(report.message).toContain("Host conn-b: needs a password");
    expect(report.message).toContain("Host conn-c: host key not trusted");
    expect(liveTabIds()).toEqual(["tab-user-a"]);
  });

  it("skips with the reasons when no target could be connected", async () => {
    const connector: UnattendedConnector = async () => ({
      status: "refused",
      reason: "credential store locked",
    });

    const report = await executeScheduledRun(fire(["conn-b"]), store, {
      connectMissing: connector,
    });

    expect(report).toEqual({
      outcome: "skipped",
      message: "Host conn-b: credential store locked",
      targetsRun: 0,
    });
    expect(injected).toEqual([]);
  });

  it("closes the tabs it opened when the run fails", async () => {
    const connector = openingConnector();
    registerTerminalInputInjector(async (tabId) => tabId === "tab-user-a");

    const report = await executeScheduledRun(fire(["conn-b"]), store, {
      connectMissing: connector,
    });

    expect(connector.calls).toEqual(["conn-b"]);
    expect(report.outcome).toBe("failed");
    expect(liveTabIds()).toEqual(["tab-user-a"]);
  });

  it("gives up on a tab that never attaches and closes it without running", async () => {
    const connector = openingConnector();
    registerTerminalReadyProbe(() => false);

    const report = await executeScheduledRun(fire(["conn-b"]), store, {
      connectMissing: connector,
      readyTimeoutMs: 0,
    });

    expect(report.outcome).toBe("skipped");
    expect(report.message).toContain("Host conn-b: the terminal did not open in time");
    expect(injected).toEqual([]);
    expect(liveTabIds()).toEqual(["tab-user-a"]);
  });

  it("skips a target whose saved connection is gone", async () => {
    const connector = openingConnector();

    const report = await executeScheduledRun(fire(["conn-gone"]), store, {
      connectMissing: connector,
    });

    expect(connector.calls).toEqual([]);
    expect(report.message).toBe("conn-gone: the saved connection no longer exists");
  });

  describe("a target connected in another window (#3878)", () => {
    /** The other windows' coverage, as the backend answers the connect window. */
    const elsewhere = (ids: string[]) => () => Promise.resolve(ids);

    it("is not connected again by the connect window, so it runs once — there", async () => {
      const connector = openingConnector();

      // Window B holds conn-b and claims it when it acknowledges the fire…
      const report = await executeScheduledRun(fire(["conn-b"]), store, {
        connectMissing: connector,
        connectedElsewhere: elsewhere(["conn-b"]),
      });

      // …so the connect window opens no second session and runs nothing on it.
      expect(connector.calls).toEqual([]);
      expect(injected).toEqual([]);
      expect(report).toMatchObject({ outcome: "skipped", targetsRun: 0 });
      expect(liveTabIds()).toEqual(["tab-user-a"]);
    });

    it("connects a target connected nowhere exactly once", async () => {
      const connector = openingConnector();

      const report = await executeScheduledRun(fire(["conn-b"]), store, {
        connectMissing: connector,
        connectedElsewhere: elsewhere([]),
      });

      expect(connector.calls).toEqual(["conn-b"]);
      expect(injected).toHaveLength(1);
      expect(report).toMatchObject({ outcome: "completed", targetsRun: 1 });
    });

    it("connects only the target no window holds when one of two is held elsewhere", async () => {
      const connector = openingConnector();

      const report = await executeScheduledRun(fire(["conn-b", "conn-c"]), store, {
        connectMissing: connector,
        connectedElsewhere: elsewhere(["conn-b"]),
      });

      expect(connector.calls).toEqual(["conn-c"]);
      expect(injected).toHaveLength(1);
      expect(report).toMatchObject({ outcome: "completed", targetsRun: 1 });
      expect(liveTabIds()).toEqual(["tab-user-a"]);
    });

    it("still runs on its own connected tab of a target also held elsewhere", async () => {
      const connector = openingConnector();

      const report = await executeScheduledRun(fire(["conn-a"]), store, {
        connectMissing: connector,
        connectedElsewhere: elsewhere(["conn-a"]),
      });

      expect(connector.calls).toEqual([]);
      expect(injected.map((i) => i.tabId)).toEqual(["tab-user-a"]);
      expect(report).toMatchObject({ outcome: "completed", targetsRun: 1 });
    });
  });

  describe("claimedTargetIds (#3878)", () => {
    it("claims the targets connected in this window", () => {
      expect(claimedTargetIds(fire(["conn-a", "conn-b"]), useAppStore.getState())).toEqual([
        "conn-a",
      ]);
    });

    it("claims nothing while this window is busy (it will skip the run)", () => {
      useAppStore.setState({
        macroPlayback: {} as ReturnType<typeof useAppStore.getState>["macroPlayback"],
      });
      expect(claimedTargetIds(fire(["conn-a"]), useAppStore.getState())).toEqual([]);
    });

    it("claims nothing when the broadcast group is gone", () => {
      const groupFire: ScheduleFire = {
        ...fire([]),
        targets: { kind: "broadcastGroup", groupId: "gone" },
      };
      expect(claimedTargetIds(groupFire, useAppStore.getState())).toEqual([]);
    });
  });

  describe("awaitRunCoverage (#3878)", () => {
    it("waits until every other window acknowledged, then returns their targets", async () => {
      const answers = [
        { settled: false, connectedElsewhere: [] },
        { settled: false, connectedElsewhere: ["conn-b"] },
        { settled: true, connectedElsewhere: ["conn-b", "conn-c"] },
      ];
      const fetch = vi.fn(() => Promise.resolve(answers.shift()!));

      const ids = await awaitRunCoverage(fetch, { pollMs: 0, timeoutMs: 1_000 });

      expect(ids).toEqual(["conn-b", "conn-c"]);
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it("gives up waiting after the timeout with what it knows", async () => {
      const fetch = vi.fn(() =>
        Promise.resolve({ settled: false, connectedElsewhere: ["conn-b"] })
      );

      const ids = await awaitRunCoverage(fetch, { pollMs: 0, timeoutMs: 0 });

      expect(ids).toEqual(["conn-b"]);
    });

    it("treats a failed query as nothing covered elsewhere", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("no backend")));

      await expect(awaitRunCoverage(fetch, { pollMs: 0, timeoutMs: 0 })).resolves.toEqual([]);
    });
  });
});
