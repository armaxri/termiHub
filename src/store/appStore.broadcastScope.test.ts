/**
 * Tests for broadcast target-selection: scope resolution and dynamic membership
 * (#1956).
 *
 * Covers `resolveBroadcastTargetTabIds` for each scope (all / panel / custom,
 * including non-terminal exclusion) and the `refreshBroadcastMembership` rule
 * that auto-adds terminals opened during an active broadcast per scope.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// The store pulls in the full service graph on import; stub the modules with
// side effects at load time (mirrors the sibling broadcast-slice suite).
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

import { useAppStore, resolveBroadcastTargetTabIds } from "./appStore";
import type {
  LeafPanel,
  PanelNode,
  SplitContainer,
  TerminalTab,
  TabContentType,
  ConnectionType,
} from "@/types/terminal";

interface SeedTab {
  id: string;
  panelId?: string;
  contentType?: TabContentType;
  connectionType?: ConnectionType;
  sessionId?: string | null;
}

function makeTab({
  id,
  panelId = "leaf-1",
  contentType = "terminal",
  connectionType = "local",
  sessionId = `sess-${id}`,
}: SeedTab): TerminalTab {
  return {
    id,
    sessionId,
    title: id,
    connectionType,
    contentType,
    config: { type: "local", config: {} },
    panelId,
    isActive: false,
  };
}

function leaf(id: string, tabs: TerminalTab[]): LeafPanel {
  return { type: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

/** Seed the active tab group with a given panel tree. */
function seed(root: PanelNode) {
  useAppStore.setState({ rootPanel: root, activePanelId: "leaf-1" });
}

describe("resolveBroadcastTargetTabIds (#1956)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("'all' resolves every terminal tab, excluding non-terminal tabs", () => {
    seed(
      leaf("leaf-1", [
        makeTab({ id: "src" }),
        makeTab({ id: "t2" }),
        makeTab({ id: "editor", contentType: "editor" }),
        makeTab({ id: "sftp", contentType: "file-browser" }),
      ])
    );
    const result = resolveBroadcastTargetTabIds(useAppStore.getState(), "all", "src").sort();
    expect(result).toEqual(["src", "t2"]);
  });

  it("'panel' resolves only terminals in the source's panel", () => {
    const split: SplitContainer = {
      type: "split",
      id: "root",
      direction: "horizontal",
      children: [
        leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" })]),
        leaf("leaf-2", [
          makeTab({ id: "t3", panelId: "leaf-2" }),
          makeTab({ id: "t4", panelId: "leaf-2" }),
        ]),
      ],
    };
    seed(split);
    // Source lives in leaf-1 → only leaf-1 terminals.
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "panel", "src").sort()).toEqual([
      "src",
      "t2",
    ]);
    // Source in leaf-2 → only leaf-2 terminals.
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "panel", "t3").sort()).toEqual([
      "t3",
      "t4",
    ]);
  });

  it("'panel' excludes non-terminal tabs in the same panel", () => {
    seed(
      leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "editor", contentType: "editor" })])
    );
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "panel", "src")).toEqual(["src"]);
  });

  it("'custom' resolves to [] — membership comes from the picker, not the scope", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" })]));
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "custom", "src")).toEqual([]);
  });

  it("'panel' returns [] when the source tab is not found", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" })]));
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "panel", "ghost")).toEqual([]);
  });

  it("resolves within the source's OWN group, not the active group (#1980)", () => {
    // Regression: a source in a non-active tab group must resolve targets in ITS
    // group's tree — never the active group's — so broadcast input can't silently
    // reach a terminal in a different, invisible group.
    const groupA = leaf("leaf-A", [
      makeTab({ id: "srcA", panelId: "leaf-A" }),
      makeTab({ id: "a2", panelId: "leaf-A" }),
    ]);
    const groupB = leaf("leaf-B", [makeTab({ id: "b1", panelId: "leaf-B" })]);
    useAppStore.setState({
      // Active group is B; its live tree is `rootPanel`. Group A is inactive and
      // keeps its tree in `group.rootPanel`.
      activeTabGroupId: "gB",
      rootPanel: groupB,
      activePanelId: "leaf-B",
      tabGroups: [
        { id: "gA", name: "A", rootPanel: groupA, activePanelId: "leaf-A" },
        { id: "gB", name: "B", rootPanel: groupB, activePanelId: "leaf-B" },
      ],
    });
    // Source lives in the INACTIVE group A → targets are A's terminals only.
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "all", "srcA").sort()).toEqual([
      "a2",
      "srcA",
    ]);
    // The active group B's terminal is never pulled in for a source in A.
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "all", "srcA")).not.toContain("b1");
    // And a source in the active group B resolves B's terminals only.
    expect(resolveBroadcastTargetTabIds(useAppStore.getState(), "all", "b1")).toEqual(["b1"]);
  });
});

describe("refreshBroadcastMembership — dynamic add on open (#1956)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
  });

  it("no-op when broadcast is inactive", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" })]));
    useAppStore.getState().refreshBroadcastMembership();
    expect(useAppStore.getState().broadcastTargetTabIds.size).toBe(0);
  });

  it("'all' auto-adds a terminal opened during broadcast", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" })]));
    useAppStore.getState().startBroadcast("all", "src", ["t2"]);

    // A new terminal appears in the tree, then membership refreshes.
    seed(leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" }), makeTab({ id: "t3" })]));
    useAppStore.getState().refreshBroadcastMembership();

    expect([...useAppStore.getState().broadcastTargetTabIds].sort()).toEqual(["src", "t2", "t3"]);
  });

  it("'all' does not add a non-terminal tab opened during broadcast", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" })]));
    useAppStore.getState().startBroadcast("all", "src", []);

    seed(
      leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "editor", contentType: "editor" })])
    );
    useAppStore.getState().refreshBroadcastMembership();

    expect([...useAppStore.getState().broadcastTargetTabIds]).toEqual(["src"]);
  });

  it("'panel' auto-adds only terminals opened in the source panel", () => {
    const split: SplitContainer = {
      type: "split",
      id: "root",
      direction: "horizontal",
      children: [
        leaf("leaf-1", [makeTab({ id: "src" })]),
        leaf("leaf-2", [makeTab({ id: "t3", panelId: "leaf-2" })]),
      ],
    };
    seed(split);
    useAppStore.getState().startBroadcast("panel", "src", []);

    // Open one terminal in each panel.
    const split2: SplitContainer = {
      type: "split",
      id: "root",
      direction: "horizontal",
      children: [
        leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" })]),
        leaf("leaf-2", [
          makeTab({ id: "t3", panelId: "leaf-2" }),
          makeTab({ id: "t4", panelId: "leaf-2" }),
        ]),
      ],
    };
    seed(split2);
    useAppStore.getState().refreshBroadcastMembership();

    // Only the terminal opened in the source panel (leaf-1) is added.
    expect([...useAppStore.getState().broadcastTargetTabIds].sort()).toEqual(["src", "t2"]);
  });

  it("'custom' never auto-adds a terminal opened during broadcast", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" })]));
    useAppStore.getState().startBroadcast("custom", "src", ["t2"]);

    seed(leaf("leaf-1", [makeTab({ id: "src" }), makeTab({ id: "t2" }), makeTab({ id: "t3" })]));
    useAppStore.getState().refreshBroadcastMembership();

    expect([...useAppStore.getState().broadcastTargetTabIds].sort()).toEqual(["src", "t2"]);
  });

  it("addTab wires the auto-add: opening a terminal under 'all' extends the set", () => {
    seed(leaf("leaf-1", [makeTab({ id: "src" })]));
    useAppStore.getState().startBroadcast("all", "src", []);

    const newId = useAppStore
      .getState()
      .addTab("Terminal", "local", { type: "local", config: {} }, { panelId: "leaf-1" });

    expect(useAppStore.getState().broadcastTargetTabIds.has(newId)).toBe(true);
  });
});
