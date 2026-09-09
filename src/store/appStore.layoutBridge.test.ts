/**
 * appStore ↔ layout projection bridge wiring (#2283 slice E2 — the region as the
 * sole writer of `appStore`'s layout).
 *
 * Drives the layout ops through the **real**
 * {@link import("./layoutBridge").mirrorLayoutIntent} path against an in-memory
 * backend double ({@link FakeLayoutTransport}) that folds the granular `layout.*`
 * intents like the Rust store. It pins the slice's contract:
 *
 * - the local reducers are gone — `appStore.rootPanel` is composed by the
 *   region→appStore mirror, synchronously via the optimistic overlay (the timing
 *   win survives: no seed→await→reconcile round-trip before the tree updates);
 * - each op dispatches its granular `layout.*` intent, and `appStore` converges to
 *   the backend's authoritative folded view when the diff lands;
 * - a rejected dispatch leaves `appStore` on the region's (unchanged) view — there
 *   is no local fallback any more;
 * - tab **ids are preserved** across split / move / group-switch / tab-activation,
 *   so the live xterm DOM (keyed by tab id) is never remounted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";

import type { PanelNode, TerminalTab } from "@/types/terminal";
import { findLeaf, getAllLeaves } from "@/utils/panelTree";
import { FakeLayoutTransport, installLayoutHarness } from "@/test/layoutRegionTestHarness";

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

import { useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import {
  buildLayoutSnapshot,
  currentLayoutView,
  ensureLayoutRegionClient,
  reseedLayoutRegion,
  subscribeLayoutRegion,
} from "./layoutBridge";

function tab(id: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: {} as TerminalTab["config"],
    panelId: "a",
    isActive: id === "t1",
  } as TerminalTab;
}

function seedTree(): PanelNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [
      { type: "leaf", id: "a", tabs: [tab("t1"), tab("t2")], activeTabId: "t1" },
      { type: "leaf", id: "b", tabs: [tab("t3")], activeTabId: "t3" },
    ],
  };
}

/** Every tab id present anywhere in a tree, in leaf/order (id-preservation checks). */
function tabIds(root: PanelNode): string[] {
  return getAllLeaves(root).flatMap((l) => l.tabs.map((t) => t.id));
}

/** Every node id (leaf **and** split container) in a tree — for churn checks. */
function allNodeIds(root: PanelNode): string[] {
  const out: string[] = [root.id];
  if (root.type === "split") {
    for (const c of root.children) out.push(...allNodeIds(c));
  }
  return out;
}

/**
 * The active group's tree in a projected region view. Accepts both the client's
 * effective {@link currentLayoutView} (minimal tabs) and the fake backend's
 * {@link FakeLayoutTransport.regionView} (rich `PanelNode`) — both are read only
 * for structure (`getAllLeaves` + tab ids), so a loose shape suffices.
 */
function regionActiveRoot(
  view: { groups: { id: string; root: unknown }[]; activeGroupId: string } | undefined
): PanelNode | undefined {
  if (!view) return undefined;
  const g = view.groups.find((x) => x.id === view.activeGroupId) ?? view.groups[0];
  return g?.root as PanelNode | undefined;
}

async function flush(): Promise<void> {
  await flushMacrotask();
  await flushMacrotask();
}

let transport: FakeLayoutTransport;
let teardown: () => void;

/** Seed `tabContent` from a tree so it holds every live tab — the production
 * invariant that lets the region→appStore mirror source content solely from the
 * map (#2566). A direct `setState({ rootPanel })` bypasses the reducers that keep
 * these in sync, so tests that seed the tree must seed the map too. */
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

async function resetStore(root: PanelNode = seedTree(), activePanelId = "a"): Promise<void> {
  useAppStore.setState(useAppStore.getInitialState());
  seedLayoutState({ rootPanel: root, activePanelId, tabContent: tabContentFromTree(root) });
  // Under E2 `appStore`'s layout is derived solely from the region, so seed the
  // region to this tree (the mirror composes it back) rather than leaving the
  // backend twin on its default view, which the mirror would otherwise compose
  // over `appStore`.
  const s = layoutState();
  reseedLayoutRegion(buildLayoutSnapshot(s.tabGroups, s.activeTabGroupId, root, activePanelId));
  await flush();
}

beforeEach(async () => {
  ({ transport, teardown } = installLayoutHarness());
  // Pre-subscribe so the region's initial snapshot is adopted before any dispatch —
  // the fake fans snapshots synchronously, so subscribing first keeps versions
  // monotonic (production's real transport is naturally ordered).
  await ensureLayoutRegionClient();
  await resetStore();
});

afterEach(() => {
  teardown();
});

describe("E2 — region is the sole writer of appStore's layout", () => {
  it("splitPanel applies to rootPanel synchronously via the optimistic overlay", () => {
    useAppStore.getState().splitPanel("vertical");
    // No flush: the mirror composes the optimistic overlay synchronously, so
    // `appStore.rootPanel` reflects the split at once (no local reducer any more).
    expect(getAllLeaves(layoutState().rootPanel)).toHaveLength(3);
  });

  it("the region overlay reflects the split synchronously, before any ack", () => {
    useAppStore.getState().splitPanel("vertical");
    const root = regionActiveRoot(currentLayoutView());
    expect(root && getAllLeaves(root)).toHaveLength(3);
  });

  it("dispatches replaceGroups (seed) then the granular layout.split", async () => {
    transport.dispatched.length = 0;
    useAppStore.getState().splitPanel("vertical");
    await flush();
    expect(transport.kinds()).toEqual(["layout.replaceGroups", "layout.split"]);
    expect(transport.dispatched[1].payload).toMatchObject({
      panelId: "a",
      direction: "vertical",
      position: "after",
    });
  });

  it("appStore converges to the backend's authoritative view after the diff lands", async () => {
    useAppStore.getState().reorderTabs("a", 0, 1);
    await flush();
    // appStore's tree equals the backend's folded view — the mirror is deriving it.
    const backendRoot = regionActiveRoot(transport.regionView())!;
    expect(tabIds(backendRoot)).toEqual(tabIds(layoutState().rootPanel));
    expect(tabIds(regionActiveRoot(currentLayoutView())!)).toEqual(tabIds(layoutState().rootPanel));
  });

  it("threads the split's ids so optimistic id == authoritative id (no churn, #2708)", async () => {
    useAppStore.getState().splitPanel("vertical");
    // The optimistic overlay applies synchronously; capture its ids before the
    // region round-trip resolves.
    const optimisticActive = layoutState().activePanelId;
    const optimisticIds = allNodeIds(layoutState().rootPanel);
    expect(optimisticActive).toBeTruthy();

    await flush();

    // After the authoritative `layout.split` confirms, the focused-leaf id and the
    // whole tree's node ids are unchanged — the region adopted the client-minted
    // ids rather than replacing them (the pre-#2708 churn).
    expect(layoutState().activePanelId).toBe(optimisticActive);
    expect([...allNodeIds(layoutState().rootPanel)].sort()).toEqual([...optimisticIds].sort());
    // The backend's authoritative tree carries the very same ids.
    const backendRoot = regionActiveRoot(transport.regionView())!;
    expect([...allNodeIds(backendRoot)].sort()).toEqual([...optimisticIds].sort());
  });

  it("passes the client-minted newPanelId/newSplitId in the layout.split payload (#2708)", async () => {
    transport.dispatched.length = 0;
    useAppStore.getState().splitPanel("vertical");
    const optimisticActive = layoutState().activePanelId;
    await flush();
    const splitIntent = transport.dispatched.find((d) => d.kind === "layout.split");
    expect(splitIntent).toBeDefined();
    const payload = splitIntent!.payload as Record<string, unknown>;
    expect(payload.newPanelId).toBe(optimisticActive);
    expect(typeof payload.newSplitId).toBe("string");
    expect(payload.newSplitId).not.toBe(payload.newPanelId);
  });

  it("a rejected dispatch leaves appStore on the backend's (unchanged) view", async () => {
    transport.reject = true;
    useAppStore.getState().splitPanel("vertical");
    await flush();
    // No local reducer fallback any more: with the region rejecting the split, the
    // authoritative view never adopted it, so appStore follows the region back.
    expect(getAllLeaves(layoutState().rootPanel).length).toBeLessThan(3);
    const root = regionActiveRoot(currentLayoutView());
    expect(root && getAllLeaves(root).length).toBeLessThan(3);
  });
});

describe("E2 — every listed op routes its granular intent", () => {
  const cases: { name: string; run: () => void; kind: string }[] = [
    {
      name: "splitPanel",
      run: () => useAppStore.getState().splitPanel("vertical"),
      kind: "layout.split",
    },
    {
      name: "removePanel",
      run: () => useAppStore.getState().removePanel("b"),
      kind: "layout.removePanel",
    },
    {
      name: "setActivePanel",
      run: () => useAppStore.getState().setActivePanel("b"),
      kind: "layout.setActivePanel",
    },
    {
      name: "setPanelSizes",
      run: () => useAppStore.getState().setPanelSizes("root", [70, 30]),
      kind: "layout.resize",
    },
    {
      name: "reorderTabs",
      run: () => useAppStore.getState().reorderTabs("a", 0, 1),
      kind: "layout.reorderTabs",
    },
    {
      name: "setActiveTab",
      run: () => useAppStore.getState().setActiveTab("t2", "a"),
      kind: "layout.setActiveTab",
    },
    {
      name: "addTabGroup",
      run: () => useAppStore.getState().addTabGroup("Extra"),
      kind: "layout.addGroup",
    },
    {
      name: "renameTabGroup",
      run: () => {
        const gid = layoutState().activeTabGroupId;
        useAppStore.getState().renameTabGroup(gid, "Renamed");
      },
      kind: "layout.renameGroup",
    },
    {
      name: "setTabGroupColor",
      run: () => {
        const gid = layoutState().activeTabGroupId;
        useAppStore.getState().setTabGroupColor(gid, "#abcdef");
      },
      kind: "layout.setGroupColor",
    },
  ];

  for (const c of cases) {
    it(`${c.name} dispatches ${c.kind}`, async () => {
      c.run();
      await flush();
      expect(transport.kinds()).toContain(c.kind);
    });
  }

  it("addTab dispatches layout.addTab carrying the frontend-generated tab id", async () => {
    const id = layoutState().addTab("New", "local", { type: "local", config: {} });
    await flush();
    const add = transport.dispatched.find((d) => d.kind === "layout.addTab");
    expect(add).toBeDefined();
    expect((add!.payload as { tab: { id: string } }).tab.id).toBe(id);
  });

  it("closeTab dispatches layout.closeTabStructure", async () => {
    useAppStore.getState().closeTab("t2", "a");
    await flush();
    expect(transport.kinds()).toContain("layout.closeTabStructure");
  });

  it("setActiveTab activates the tab in both appStore and the region", async () => {
    useAppStore.getState().setActiveTab("t2", "a");
    await flush();
    expect(findLeaf(layoutState().rootPanel, "a")!.activeTabId).toBe("t2");
    const regionA = findLeaf(regionActiveRoot(transport.regionView())!, "a");
    expect(regionA!.activeTabId).toBe("t2");
  });
});

describe("#2712 — a panel-geometry move is a single settled-tree commit (no pre-prune emit)", () => {
  /** Record every leaf-count the region emits while running `op`. */
  async function leafCountsDuring(op: () => void): Promise<number[]> {
    transport.dispatched.length = 0;
    const counts: number[] = [];
    const unsub = subscribeLayoutRegion((view) => {
      const root = regionActiveRoot(view as Parameters<typeof regionActiveRoot>[0]);
      if (root) counts.push(getAllLeaves(root).length);
    });
    op();
    await flush();
    unsub();
    return counts;
  }

  it("a cross-panel merge commits the pruned 1-panel tree without emitting the 2-panel one", async () => {
    // seedTree: panel `a` = [t1, t2], panel `b` = [t3]. Moving t3 from `b` onto
    // `a`'s stack (center) empties `b`, which is pruned → the tree collapses to a
    // single panel. Pre = 2 panels (~narrow), settled = 1 panel (~full width).
    const counts = await leafCountsDuring(() =>
      useAppStore.getState().splitPanelWithTab("t3", "b", "a", "center")
    );

    // The move is delivered as ONE authoritative commit of the settled tree — not
    // the seed(pre)+granular pair, which would emit the pre-prune 2-panel frame
    // first. That intermediate frame is the transient narrow width that destroys
    // terminal scrollback on macOS/WKWebView (#2712, same round-trip as #2705).
    expect(transport.kinds()).toEqual(["layout.replaceGroups"]);

    // The region never emits a two-panel (pre-prune) view during the move: every
    // emitted view already holds the settled single panel.
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n === 1)).toBe(true);

    // Optimistic overlay and the authoritative backend view are structurally
    // identical — the merged single panel holding all three tabs.
    const overlayRoot = regionActiveRoot(currentLayoutView())!;
    const backendRoot = regionActiveRoot(transport.regionView())!;
    expect(getAllLeaves(overlayRoot)).toHaveLength(1);
    expect(getAllLeaves(backendRoot)).toHaveLength(1);
    expect(tabIds(overlayRoot).sort()).toEqual(["t1", "t2", "t3"]);
    expect(tabIds(overlayRoot)).toEqual(tabIds(backendRoot));
  });

  it("a cross-group move commits both groups in one replaceGroups (source pruned, no 2-panel emit)", async () => {
    // seedTree's active group is a 2-panel split: `a` = [t1, t2], `b` = [t3].
    // Moving t3 out of panel `b` empties and prunes `b`, collapsing the origin
    // group to a single panel. Add a fresh target group, keep the origin active.
    const originGroup = layoutState().activeTabGroupId;
    const targetGroup = useAppStore.getState().addTabGroup("Target");
    useAppStore.getState().setActiveTabGroup(originGroup);
    await flush();

    const counts = await leafCountsDuring(() =>
      useAppStore.getState().moveTabToGroup("t3", "b", targetGroup)
    );

    // Single atomic commit of the whole multi-group layout: no seed(pre)+granular
    // pair, so the region never re-renders the pre-prune source geometry.
    expect(transport.kinds()).toEqual(["layout.replaceGroups"]);
    // The active (origin) group's emitted views never revert to the pre-prune
    // two-panel state — the emptied source panel is already gone in every emit.
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n === 1)).toBe(true);
    // The tab left the origin group and landed in the target group.
    expect(tabIds(layoutState().rootPanel)).toEqual(["t1", "t2"]);
    const target = layoutState().tabGroups.find((g) => g.id === targetGroup)!;
    expect(tabIds(target.rootPanel)).toContain("t3");
  });
});

describe("E2 — tab id preservation (no live-terminal remount)", () => {
  it("split preserves every existing tab id", () => {
    const before = tabIds(layoutState().rootPanel);
    useAppStore.getState().splitPanel("vertical");
    expect(tabIds(layoutState().rootPanel)).toEqual(before);
  });

  it("drag-move (center) preserves the moved tab id and its stack neighbours", () => {
    useAppStore.getState().splitPanelWithTab("t1", "a", "b", "center");
    const ids = tabIds(layoutState().rootPanel).sort();
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });

  it("group switch keeps each group's tab ids intact", async () => {
    // The seed tree lives in the first group. Add a fresh (empty) group — which
    // becomes active — then switch back to the first and assert its tabs survived.
    useAppStore.getState().addTabGroup("G2");
    await flush();
    const firstGroup = layoutState().tabGroups[0].id;
    useAppStore.getState().setActiveTabGroup(firstGroup);
    await flush();
    expect(tabIds(layoutState().rootPanel).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("tab activation never changes tab ids, only the active flag", () => {
    const before = tabIds(layoutState().rootPanel);
    useAppStore.getState().setActiveTab("t2", "a");
    expect(tabIds(layoutState().rootPanel)).toEqual(before);
    expect(findLeaf(layoutState().rootPanel, "a")!.activeTabId).toBe("t2");
  });
});
