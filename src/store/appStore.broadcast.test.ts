/**
 * Tests for the broadcast-input store actions (#1955) against the authoritative
 * `broadcast@<clientId>` region (#2206).
 *
 * Pins the broadcast actions now that the region is the single source of truth
 * (the appStore reducers are gone): start/stop/add/remove/isTarget dispatch
 * `broadcast.*` intents, and the state is asserted via `currentBroadcastView()`.
 * Also covers the connected-only target resolution the `onData` fan-out relies on
 * (`getBroadcastTargetTabIds`), the source-inclusion invariant, and the
 * source-close teardown wired into `closeTab`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The store pulls in the full service graph on import; stub the modules with
// side effects at load time (mirrors the sibling macro-slice suites).
vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

import { useAppStore } from "./appStore";
import { currentBroadcastView, ensureBroadcastSubscribed } from "./broadcastBridge";
import { ensureSessionSubscribed } from "./sessionBridge";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import {
  connecting,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import type { LeafPanel, TerminalTab, TabContentType } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

interface SeedTab {
  id: string;
  contentType?: TabContentType;
  sessionId?: string | null;
}

/** Build a terminal-ish tab with sensible defaults for the broadcast tests. */
function makeTab({ id, contentType = "terminal", sessionId = `sess-${id}` }: SeedTab): TerminalTab {
  return {
    id,
    sessionId,
    title: id,
    connectionType: "local",
    contentType,
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: id === "src",
  };
}

/** Seed a single leaf panel holding the given tabs as the active tab group. */
function seedTabs(tabs: TerminalTab[], activeTabId = tabs[0]?.id ?? null) {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("appStore — broadcast input actions (#1955, region-authoritative #2206)", () => {
  let harness: ReturnType<typeof installBroadcastHarness>;

  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState());
    harness = installBroadcastHarness();
    // Subscribe so the actions' dispatched intents round-trip into
    // `currentBroadcastView()` synchronously (the fake transport folds + fans
    // synchronously, and ProjectionClient applies frames synchronously).
    await ensureBroadcastSubscribed();
  });

  afterEach(() => {
    harness.teardown();
  });

  it("starts inactive with the default 'all' scope and empty target set", () => {
    const v = currentBroadcastView();
    expect(v.active).toBe(false);
    expect(v.sourceTabId).toBeNull();
    expect(v.scope).toBe("all");
    expect(v.lastScope).toBe("all");
    expect(v.targetTabIds).toHaveLength(0);
  });

  it("startBroadcast activates, sets source/scope, and includes the source as a target", () => {
    useAppStore.getState().startBroadcast("all", "src", ["t2", "t3"]);

    const v = currentBroadcastView();
    expect(v.active).toBe(true);
    expect(v.sourceTabId).toBe("src");
    expect(v.scope).toBe("all");
    expect(v.lastScope).toBe("all");
    // Source is just another target — the fan-out loop stays uniform.
    expect([...v.targetTabIds].sort()).toEqual(["src", "t2", "t3"]);
  });

  it("stopBroadcast clears active/source/targets", () => {
    useAppStore.getState().startBroadcast("all", "src", ["t2"]);
    useAppStore.getState().stopBroadcast();

    const v = currentBroadcastView();
    expect(v.active).toBe(false);
    expect(v.sourceTabId).toBeNull();
    expect(v.targetTabIds).toHaveLength(0);
  });

  it("remembers the last scope after stopping (for the shortcut toggle)", () => {
    useAppStore.getState().startBroadcast("panel", "src", []);
    useAppStore.getState().stopBroadcast();
    expect(currentBroadcastView().lastScope).toBe("panel");
  });

  it("add/remove/isBroadcastTarget mutate the target set", () => {
    const store = useAppStore.getState();
    store.startBroadcast("all", "src", []);

    expect(store.isBroadcastTarget("t2")).toBe(false);
    store.addBroadcastTarget("t2");
    expect(store.isBroadcastTarget("t2")).toBe(true);
    expect(currentBroadcastView().targetTabIds).toContain("src");

    store.removeBroadcastTarget("t2");
    expect(store.isBroadcastTarget("t2")).toBe(false);
  });

  it("addBroadcastTarget is idempotent (a no-op add dispatches nothing)", () => {
    const store = useAppStore.getState();
    store.startBroadcast("all", "src", ["t2"]);
    harness.transport.dispatched.length = 0;
    store.addBroadcastTarget("t2");
    // Already a target → no redundant intent, no duplicate in the region.
    expect(harness.transport.kinds()).toEqual([]);
    expect(currentBroadcastView().targetTabIds).toHaveLength(2);
  });

  describe("getBroadcastTargetTabIds — connected-only filtering", () => {
    // Connecting/reconnecting status is region-sourced (#2205 PR-B).
    const sessionHarness = installSessionLifecycleHarness();

    it("returns [] when broadcast is inactive", () => {
      seedTabs([makeTab({ id: "src" })]);
      expect(useAppStore.getState().getBroadcastTargetTabIds()).toEqual([]);
    });

    it("keeps only connected terminal targets, dropping the rest silently", async () => {
      seedTabs([
        makeTab({ id: "src" }), // connected terminal
        makeTab({ id: "t2" }), // connected terminal
        makeTab({ id: "t3" }), // terminal but exited
        makeTab({ id: "t4" }), // terminal but connecting
        makeTab({ id: "t5", contentType: "editor" }), // non-terminal tab
        makeTab({ id: "t6", sessionId: null }), // terminal without a live session
      ]);
      useAppStore.setState({
        terminalExitedTabs: { t3: true },
      });
      // Connecting status is sourced from the session-lifecycle region now
      // (#2205 PR-B): seed t4 as connecting there so it is excluded.
      await ensureSessionSubscribed();
      sessionHarness.transport.setSession("t4", connecting());
      useAppStore.getState().startBroadcast("all", "src", ["t2", "t3", "t4", "t5", "t6"]);

      const result = useAppStore.getState().getBroadcastTargetTabIds().sort();
      expect(result).toEqual(["src", "t2"]);
    });

    it("drops a target whose tab no longer exists", () => {
      seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" })]);
      useAppStore.getState().startBroadcast("all", "src", ["t2", "ghost"]);
      expect(useAppStore.getState().getBroadcastTargetTabIds().sort()).toEqual(["src", "t2"]);
    });

    it("skips a target that later fails (spawn error)", () => {
      seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" })]);
      useAppStore.getState().startBroadcast("all", "src", ["t2"]);
      expect(useAppStore.getState().getBroadcastTargetTabIds().sort()).toEqual(["src", "t2"]);

      useAppStore.setState({ terminalSpawnErrors: { t2: "boom" } });
      expect(useAppStore.getState().getBroadcastTargetTabIds()).toEqual(["src"]);
    });
  });

  describe("onData routing decision (source vs non-source vs inactive)", () => {
    // The fan-out branch in Terminal.tsx broadcasts iff broadcast is active AND
    // this terminal is the source; every other case falls through to the normal
    // single-session send. This mirrors that predicate against store state.
    const shouldBroadcast = (tabId: string) => {
      const v = currentBroadcastView();
      return v.active && v.sourceTabId === tabId;
    };

    beforeEach(() => {
      seedTabs([makeTab({ id: "src" }), makeTab({ id: "t2" })]);
    });

    it("the source broadcasts to all connected targets", () => {
      useAppStore.getState().startBroadcast("all", "src", ["t2"]);
      expect(shouldBroadcast("src")).toBe(true);
      expect(useAppStore.getState().getBroadcastTargetTabIds().sort()).toEqual(["src", "t2"]);
    });

    it("a non-source terminal falls through to single-session input", () => {
      useAppStore.getState().startBroadcast("all", "src", ["t2"]);
      expect(shouldBroadcast("t2")).toBe(false);
    });

    it("no terminal broadcasts while inactive", () => {
      expect(shouldBroadcast("src")).toBe(false);
      expect(shouldBroadcast("t2")).toBe(false);
    });
  });

  describe("closeTab teardown", () => {
    it("closing the source tab ends broadcast entirely", () => {
      // sessionId null avoids the backend session-release path in closeTab.
      seedTabs([makeTab({ id: "src", sessionId: null }), makeTab({ id: "t2", sessionId: null })]);
      useAppStore.getState().startBroadcast("all", "src", ["t2"]);

      useAppStore.getState().closeTab("src", "leaf-1");

      const v = currentBroadcastView();
      expect(v.active).toBe(false);
      expect(v.sourceTabId).toBeNull();
      expect(v.targetTabIds).toHaveLength(0);
    });

    it("closing a plain target drops it from the set but keeps broadcast active", () => {
      seedTabs([makeTab({ id: "src", sessionId: null }), makeTab({ id: "t2", sessionId: null })]);
      useAppStore.getState().startBroadcast("all", "src", ["t2"]);

      useAppStore.getState().closeTab("t2", "leaf-1");

      const v = currentBroadcastView();
      expect(v.active).toBe(true);
      expect(v.sourceTabId).toBe("src");
      expect(v.targetTabIds).not.toContain("t2");
      expect(v.targetTabIds).toContain("src");
    });
  });
});
