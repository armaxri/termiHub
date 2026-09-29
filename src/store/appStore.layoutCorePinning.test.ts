/**
 * Pinning tests for the core tabs/panel layout domain (ARCH-001/FES-011, #2881).
 *
 * Written before the layout core was lifted out of the monolithic root store into
 * its own slice, and required to pass unchanged before and after that move. They
 * pin the behavior the move must not disturb:
 *
 * - `setAndReseed` (#2562): the coupled non-layout fields are written **before**
 *   the region reseed, so the reseed's composition already sees them; a no-op
 *   reducer writes and dispatches nothing;
 * - `closeTab`: the per-tab map cleanup, the persistent-session detach, and the
 *   ordering of the session-remove intent and the on-disconnect workflow hook
 *   (#3791 / #3793), which must run while the tab is still in the layout;
 * - a split / move / close sequence leaves `rootPanel` / `tabGroups` in exactly
 *   the pinned shape, in both `appStore` and the authoritative region;
 * - the zoom-follow rollback (#3256 / SM-027) for `setActiveTab` and
 *   `setActivePanel`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";

import type { PanelNode, TabGroup, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import { FakeLayoutTransport, installLayoutHarness } from "@/test/layoutRegionTestHarness";

const callLog = vi.hoisted(() => [] as string[]);

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

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return { ...actual, toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() } };
});

vi.mock("./sessionBridge", async () => {
  const actual = await vi.importActual<typeof import("./sessionBridge")>("./sessionBridge");
  return {
    ...actual,
    mirrorSessionIntent: vi.fn((...args: Parameters<typeof actual.mirrorSessionIntent>) => {
      callLog.push(`${args[0]}:${args[1]}`);
      return actual.mirrorSessionIntent(...args);
    }),
  };
});

vi.mock("./workflowSessionTriggers", async () => {
  const actual = await vi.importActual<typeof import("./workflowSessionTriggers")>(
    "./workflowSessionTriggers"
  );
  return {
    ...actual,
    notifyWorkflowTabClosing: vi.fn(
      (...args: Parameters<typeof actual.notifyWorkflowTabClosing>) => {
        callLog.push(`workflow-close:${args[1]}`);
        return actual.notifyWorkflowTabClosing(...args);
      }
    ),
  };
});

import { collectLiveTabs, useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import {
  buildLayoutSnapshot,
  currentLayoutView,
  ensureLayoutRegionClient,
  reseedLayoutRegion,
} from "./layoutBridge";
import { notifyWorkflowTabClosing } from "./workflowSessionTriggers";

function tab(id: string, panelId: string, isActive: boolean): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId,
    isActive,
  } as TerminalTab;
}

function seedTree(): PanelNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      {
        type: "leaf",
        id: "a",
        tabs: [tab("t1", "a", true), tab("t2", "a", false)],
        activeTabId: "t1",
      },
      { type: "leaf", id: "b", tabs: [tab("t3", "b", true)], activeTabId: "t3" },
    ],
  };
}

function tabContentFromTree(
  root: PanelNode
): Record<string, import("@/types/terminal").TabContent> {
  const map: Record<string, import("@/types/terminal").TabContent> = {};
  for (const leaf of getAllLeaves(root)) {
    for (const t of leaf.tabs) {
      const { panelId: _p, isActive: _a, ...content } = t;
      map[t.id] = content;
    }
  }
  return map;
}

async function flush(): Promise<void> {
  await flushMacrotask();
  await flushMacrotask();
}

let transport: FakeLayoutTransport;
let teardown: () => void;

async function resetStore(root: PanelNode = seedTree(), activePanelId = "a"): Promise<void> {
  useAppStore.setState(useAppStore.getInitialState());
  seedLayoutState({ rootPanel: root, activePanelId, tabContent: tabContentFromTree(root) });
  const s = layoutState();
  reseedLayoutRegion(buildLayoutSnapshot(s.tabGroups, s.activeTabGroupId, root, activePanelId));
  await flush();
}

beforeEach(async () => {
  ({ transport, teardown } = installLayoutHarness());
  await ensureLayoutRegionClient();
  await resetStore();
  transport.dispatched.length = 0;
  transport.reject = false;
  callLog.length = 0;
  vi.mocked(notifyWorkflowTabClosing).mockClear();
});

afterEach(() => {
  teardown();
});

/**
 * Record every `appStore` change while `op` runs, classified by whether the
 * change touched the region-mirrored `layoutView`, the coupled fields listed in
 * `coupled`, or both.
 */
function recordChanges(coupled: string[], op: () => void): string[] {
  const events: string[] = [];
  const unsub = useAppStore.subscribe((state, prev) => {
    const parts: string[] = [];
    const s = state as unknown as Record<string, unknown>;
    const p = prev as unknown as Record<string, unknown>;
    if (coupled.some((k) => s[k] !== p[k])) parts.push("coupled");
    if (state.layoutView !== prev.layoutView) parts.push("layoutView");
    events.push(parts.join("+") || "other");
  });
  try {
    op();
  } finally {
    unsub();
  }
  return events;
}

describe("setAndReseed ordering (#2562)", () => {
  it("writes the coupled fields before the reseed lands, then reseeds once", async () => {
    let contentSeenByReseed = false;
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.layoutView !== prev.layoutView) {
        contentSeenByReseed = Object.values(state.tabContent).some(
          (c) => c.contentType === "settings"
        );
      }
    });
    const events = recordChanges(["tabContent", "pendingSettingsCategory"], () =>
      useAppStore.getState().openSettingsTab({ category: "appearance" })
    );
    unsub();
    // First the local `set(rest)` of the coupled fields (layout untouched), then
    // the optimistic reseed's mirror write of `layoutView` — never merged, never
    // reversed.
    expect(events).toEqual(["coupled", "layoutView"]);
    // The reseed's composition already saw the new settings tab's content.
    expect(contentSeenByReseed).toBe(true);
    await flush();
    expect(transport.kinds()).toEqual(["layout.replaceGroups"]);
  });

  it("a reducer with no coupled fields reseeds without a local pre-write", async () => {
    const events = recordChanges(["tabContent"], () =>
      useAppStore.getState().moveTab("t3", "b", "a", 0)
    );
    expect(events).toEqual(["layoutView"]);
    await flush();
    expect(transport.kinds()).toEqual(["layout.replaceGroups"]);
    expect(getAllLeaves(layoutState().rootPanel).map((l) => l.tabs.map((t) => t.id))).toEqual([
      ["t3", "t1", "t2"],
    ]);
  });

  it("a no-op reducer writes nothing and dispatches nothing", async () => {
    const events = recordChanges(["tabContent"], () =>
      useAppStore.getState().moveTab("t1", "a", "a", 0)
    );
    expect(events).toEqual([]);
    await flush();
    expect(transport.dispatched).toEqual([]);
  });
});

describe("closeTab cleanup (FES-003, #3791 / #3793)", () => {
  const PER_TAB_MAPS = [
    "tabCwds",
    "tabHorizontalScrolling",
    "editorDirtyTabs",
    "tabColors",
    "tabTerminalOptions",
    "terminalSearchVisible",
    "terminalSpawnErrors",
    "terminalSpawnErrorKinds",
    "terminalRetryCounters",
    "terminalConnectDeadline",
    "terminalViewMode",
    "terminalReattaching",
    "terminalReconnectPrompt",
    "terminalAutoRetryCount",
    "terminalWaitingForAgent",
    "terminalForceFreshReconnect",
  ] as const;

  function seedPerTabMaps(): void {
    const patch: Record<string, unknown> = {};
    for (const key of PER_TAB_MAPS) patch[key] = { t1: `v1-${key}`, t2: `v2-${key}` };
    patch.persistentSessions = {
      c1: { connectionId: "c1", sessionId: "p1", state: "running", attachedTabIds: ["t1", "t2"] },
      c2: { connectionId: "c2", sessionId: "p2", state: "running", attachedTabIds: ["t3"] },
    };
    patch.zoomedTabId = "t1";
    useAppStore.setState(patch as never);
  }

  it("prunes every per-tab map for the closed tab only", () => {
    seedPerTabMaps();
    useAppStore.getState().closeTab("t1", "a");
    const s = useAppStore.getState() as unknown as Record<string, Record<string, unknown>>;
    for (const key of PER_TAB_MAPS) {
      expect(s[key], key).toEqual({ t2: `v2-${key}` });
    }
    expect(useAppStore.getState().tabContent.t1).toBeUndefined();
    expect(Object.keys(useAppStore.getState().tabContent).sort()).toEqual(["t2", "t3"]);
    expect(useAppStore.getState().persistentSessions.c1.attachedTabIds).toEqual(["t2"]);
    expect(useAppStore.getState().persistentSessions.c2.attachedTabIds).toEqual(["t3"]);
    expect(useAppStore.getState().zoomedTabId).toBeNull();
  });

  it("closing the last tab of a panel removes the panel and repoints focus", () => {
    seedPerTabMaps();
    useAppStore.getState().setActivePanel("b");
    useAppStore.getState().closeTab("t3", "b");
    const leaves = getAllLeaves(layoutState().rootPanel);
    expect(leaves.map((l) => l.id)).toEqual(["a"]);
    expect(layoutState().activePanelId).toBe("a");
    expect(useAppStore.getState().persistentSessions.c2.attachedTabIds).toEqual([]);
  });

  it("removes the session record, then runs the on-disconnect hook while the tab is still laid out", async () => {
    let presentAtHook: boolean | null = null;
    let hookStoreIsLive = false;
    vi.mocked(notifyWorkflowTabClosing).mockImplementationOnce((store, tabId) => {
      callLog.push(`workflow-close:${tabId}`);
      presentAtHook = collectLiveTabs(store.get()).some((t) => t.id === tabId);
      hookStoreIsLive = store.get() === useAppStore.getState();
    });
    useAppStore.getState().closeTab("t2", "a");
    expect(callLog.slice(0, 2)).toEqual(["session.remove:t2", "workflow-close:t2"]);
    expect(notifyWorkflowTabClosing).toHaveBeenCalledTimes(1);
    expect(presentAtHook).toBe(true);
    expect(hookStoreIsLive).toBe(true);
    // The tab has left the layout once closeTab returns.
    expect(collectLiveTabs(useAppStore.getState()).some((t) => t.id === "t2")).toBe(false);
    await flush();
    expect(transport.kinds()).toEqual(["layout.replaceGroups", "layout.closeTabStructure"]);
  });
});

/**
 * Relabel generated ids (panels, splits, groups) in encounter order so a pinned
 * shape is independent of the random id minting. Seeded ids (`t*`, `a`, `b`,
 * `root`) keep their names.
 */
function normalize(groups: TabGroup[], activeGroupId: string, activePanelId: string | null) {
  const labels = new Map<string, string>();
  const label = (id: string | null | undefined): string | null => {
    if (id == null) return null;
    if (/^(t\d+|a|b|root)$/.test(id)) return id;
    if (!labels.has(id)) labels.set(id, `#${labels.size + 1}`);
    return labels.get(id)!;
  };
  const node = (n: PanelNode): unknown =>
    n.type === "leaf"
      ? {
          leaf: label(n.id),
          active: label(n.activeTabId),
          tabs: n.tabs.map((t) => `${t.id}@${label(t.panelId)}${t.isActive ? "*" : ""}`),
        }
      : {
          split: label(n.id),
          dir: n.direction,
          sizes: n.sizes ?? null,
          children: n.children.map(node),
        };
  return {
    groups: groups.map((g) => ({
      id: label(g.id),
      name: g.name,
      color: g.color ?? null,
      activePanelId: label(g.activePanelId),
      root: node(g.rootPanel),
    })),
    activeGroup: label(activeGroupId),
    activePanel: label(activePanelId),
  };
}

function composedShape() {
  const s = layoutState();
  const groups = s.tabGroups.map((g) =>
    g.id === s.activeTabGroupId
      ? { ...g, rootPanel: s.rootPanel, activePanelId: s.activePanelId }
      : g
  );
  return normalize(groups, s.activeTabGroupId, s.activePanelId);
}

describe("split / move / close sequences leave the layout in the pinned shape", () => {
  it("split → move into the new panel → activate → close → reorder", async () => {
    useAppStore.getState().splitPanel("vertical");
    const newPanel = layoutState().activePanelId!;
    useAppStore.getState().moveTab("t2", "a", newPanel, 0);
    useAppStore.getState().setActiveTab("t1", "a");
    useAppStore.getState().closeTab("t3", "b");
    useAppStore.getState().setPanelSizes(layoutState().rootPanel.id, [40, 60]);
    await flush();
    const shape = composedShape();
    expect(shape).toMatchInlineSnapshot(`
      {
        "activeGroup": "#1",
        "activePanel": "a",
        "groups": [
          {
            "activePanelId": "a",
            "color": null,
            "id": "#1",
            "name": "Main",
            "root": {
              "children": [
                {
                  "active": "t1",
                  "leaf": "a",
                  "tabs": [
                    "t1@a*",
                  ],
                },
                {
                  "active": "t2",
                  "leaf": "#3",
                  "tabs": [
                    "t2@#3*",
                  ],
                },
              ],
              "dir": "vertical",
              "sizes": [
                40,
                60,
              ],
              "split": "#2",
            },
          },
        ],
      }
    `);
    // The region converged on the very same tree.
    const view = currentLayoutView()!;
    const activeRegionGroup = view.groups.find((g) => g.id === view.activeGroupId)!;
    expect(
      getAllLeaves(activeRegionGroup.root as unknown as PanelNode).map((l) =>
        l.tabs.map((t) => t.id)
      )
    ).toEqual(getAllLeaves(layoutState().rootPanel).map((l) => l.tabs.map((t) => t.id)));
  });

  it("group add → cross-group move → split with tab → rename / color → switch back", async () => {
    const origin = layoutState().activeTabGroupId;
    const target = useAppStore.getState().addTabGroup("Second");
    useAppStore.getState().setActiveTabGroup(origin);
    useAppStore.getState().moveTabToGroup("t3", "b", target);
    useAppStore.getState().splitPanelWithTab("t2", "a", "a", "bottom");
    useAppStore.getState().renameTabGroup(origin, "Renamed");
    useAppStore.getState().setTabGroupColor(target, "#123456");
    useAppStore.getState().setActiveTabGroup(target);
    useAppStore.getState().setActiveTabGroup(origin);
    await flush();
    expect(composedShape()).toMatchInlineSnapshot(`
      {
        "activeGroup": "#1",
        "activePanel": "#2",
        "groups": [
          {
            "activePanelId": "#2",
            "color": null,
            "id": "#1",
            "name": "Renamed",
            "root": {
              "children": [
                {
                  "active": "t1",
                  "leaf": "a",
                  "tabs": [
                    "t1@a*",
                  ],
                },
                {
                  "active": "t2",
                  "leaf": "#2",
                  "tabs": [
                    "t2@#2*",
                  ],
                },
              ],
              "dir": "vertical",
              "sizes": null,
              "split": "#3",
            },
          },
          {
            "activePanelId": "#5",
            "color": "#123456",
            "id": "#4",
            "name": "Second",
            "root": {
              "active": "t3",
              "leaf": "#5",
              "tabs": [
                "t3@#5*",
              ],
            },
          },
        ],
      }
    `);
  });

  it("closing every tab collapses back to a single empty leaf", async () => {
    useAppStore.getState().closeTab("t1", "a");
    useAppStore.getState().closeTab("t2", "a");
    useAppStore.getState().closeTab("t3", "b");
    await flush();
    expect(composedShape()).toMatchInlineSnapshot(`
      {
        "activeGroup": "#1",
        "activePanel": "b",
        "groups": [
          {
            "activePanelId": "b",
            "color": null,
            "id": "#1",
            "name": "Main",
            "root": {
              "active": null,
              "leaf": "b",
              "tabs": [],
            },
          },
        ],
      }
    `);
  });
});

describe("zoom-follow rollback (#3256 / SM-027)", () => {
  it("an accepted setActiveTab follows the zoom overlay within the panel", async () => {
    useAppStore.setState({ zoomedTabId: "t1" });
    useAppStore.getState().setActiveTab("t2", "a");
    await flush();
    expect(useAppStore.getState().zoomedTabId).toBe("t2");
  });

  it("setActiveTab in another panel leaves the zoom overlay alone", async () => {
    useAppStore.setState({ zoomedTabId: "t1" });
    useAppStore.getState().setActiveTab("t3", "b");
    await flush();
    expect(useAppStore.getState().zoomedTabId).toBe("t1");
  });

  it("a rejected setActiveTab restores the zoom overlay with the structure", async () => {
    useAppStore.setState({ zoomedTabId: "t1" });
    transport.reject = true;
    useAppStore.getState().setActiveTab("t2", "a");
    // Optimistic: the zoom followed at once.
    expect(useAppStore.getState().zoomedTabId).toBe("t2");
    await flush();
    expect(useAppStore.getState().zoomedTabId).toBe("t1");
    expect(getAllLeaves(layoutState().rootPanel)[0].activeTabId).toBe("t1");
  });

  it("a rejected setActivePanel does not clobber a newer zoom write", async () => {
    useAppStore.setState({ zoomedTabId: "t1" });
    transport.reject = true;
    useAppStore.getState().setActivePanel("b");
    expect(useAppStore.getState().zoomedTabId).toBe("t3");
    // A newer write supersedes the optimistic zoom-follow before the rejection.
    useAppStore.setState({ zoomedTabId: "t2" });
    await flush();
    expect(layoutState().activePanelId).toBe("a");
    expect(useAppStore.getState().zoomedTabId).toBe("t2");
  });
});
