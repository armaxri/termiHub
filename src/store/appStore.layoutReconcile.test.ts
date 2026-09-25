/**
 * SM-024 (#3336) — the layout must reconcile, not freeze on a stale tree, when a
 * region view cannot be composed strictly (a view tab absent from `tabContent`).
 *
 * Before the fix the region→appStore mirror skipped any view `composeLayoutFromView`
 * returned `null` for, and `getComposedLayout` reused a module-global last-good
 * tree — so `appStore` stayed frozen on a stale panel tree while the authoritative
 * region had moved on, with nothing to re-run the skipped view once content caught
 * up. These tests pin the reconcile contract for each cause of a `null` compose:
 *
 *  - a rejected optimistic intent whose overlay rollback emits a view referencing
 *    a tab whose `tabContent` entry is restored only afterwards (#3256 ordering);
 *  - an authoritative view that references a tab this client has no content for;
 *  - content that catches up after the view (transient desync);
 *  - an empty / absent view (nothing to derive from — keep the last good tree).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { flushMacrotask } from "@/test/flushAsync";

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

import type { LeafPanel, PanelNode, TabContent, TerminalTab } from "@/types/terminal";
import { getAllLeaves } from "@/utils/panelTree";
import {
  FakeLayoutTransport,
  type FullLayoutView,
  installLayoutHarness,
} from "@/test/layoutRegionTestHarness";
import { useAppStore, getComposedLayout } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import {
  buildLayoutSnapshot,
  currentLayoutView,
  ensureLayoutRegionClient,
  reseedLayoutRegion,
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

function tabIds(root: PanelNode): string[] {
  return getAllLeaves(root).flatMap((l) => l.tabs.map((t) => t.id));
}

function regionActiveRoot(
  view: { groups: { id: string; root: unknown }[]; activeGroupId: string } | undefined
): PanelNode {
  const g = view!.groups.find((x) => x.id === view!.activeGroupId) ?? view!.groups[0];
  return g.root as PanelNode;
}

function tabContentFromTree(root: PanelNode): Record<string, TabContent> {
  const map: Record<string, TabContent> = {};
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

/** A copy of the backend's view with leaf `leafId`'s tab list replaced. */
function withLeafTabs(
  view: FullLayoutView,
  leafId: string,
  tabs: TerminalTab[],
  activeTabId: string | null
): FullLayoutView {
  const next = structuredClone(view);
  const walk = (n: PanelNode): PanelNode => {
    if (n.type === "leaf") {
      return n.id === leafId ? ({ ...n, tabs, activeTabId } as LeafPanel) : n;
    }
    return { ...n, children: n.children.map(walk) };
  };
  next.groups = next.groups.map((g) =>
    g.id === next.activeGroupId ? { ...g, root: walk(g.root) } : g
  );
  return next;
}

let transport: FakeLayoutTransport;
let teardown: () => void;

beforeEach(async () => {
  ({ transport, teardown } = installLayoutHarness());
  await ensureLayoutRegionClient();
  useAppStore.setState(useAppStore.getInitialState());
  const root = seedTree();
  seedLayoutState({ rootPanel: root, activePanelId: "a", tabContent: tabContentFromTree(root) });
  const s = layoutState();
  reseedLayoutRegion(buildLayoutSnapshot(s.tabGroups, s.activeTabGroupId, root, "a"));
  await flush();
});

afterEach(() => {
  teardown();
});

describe("SM-024 — rejected intent rollback does not strand appStore on a stale tree", () => {
  it("a rejected closeTab converges appStore back onto the region's tree", async () => {
    transport.reject = true;
    useAppStore.getState().closeTab("t2", "a");
    await flush();

    // The overlay rolled the structure back (region still has t2) and the coupled
    // rollback restored t2's content: appStore must follow the region, not stay
    // frozen on the optimistic post-close tree.
    const regionTabs = tabIds(regionActiveRoot(currentLayoutView()));
    expect(regionTabs).toContain("t2");
    expect(useAppStore.getState().tabContent.t2).toBeDefined();
    expect(tabIds(layoutState().rootPanel)).toEqual(regionTabs);
  });
});

describe("SM-024 — an authoritative view with a dangling tab reconciles", () => {
  it("applies the region's structure, dropping the tab it has no content for", async () => {
    // The authoritative region moves on: leaf `a` is reordered AND references a
    // tab (`ghost`) this client has no content for.
    const ghost = tab("ghost");
    transport.seed(withLeafTabs(transport.regionView(), "a", [tab("t2"), tab("t1"), ghost], "t2"));
    await flush();

    // Not frozen: the reorder landed; the unrenderable tab is dropped.
    expect(tabIds(layoutState().rootPanel)).toEqual(["t2", "t1", "t3"]);
  });

  it("repairs the leaf's active tab when the dangling tab was the active one", async () => {
    transport.seed(withLeafTabs(transport.regionView(), "a", [tab("t1"), tab("ghost")], "ghost"));
    await flush();

    const leafA = getAllLeaves(layoutState().rootPanel).find((l) => l.id === "a")!;
    expect(leafA.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(leafA.activeTabId).toBe("t1");
    expect(leafA.tabs[0].isActive).toBe(true);
  });

  it("reseeds the region so it converges to the reconciled tree", async () => {
    transport.seed(withLeafTabs(transport.regionView(), "a", [tab("t1"), tab("ghost")], "t1"));
    await vi.waitFor(() => {
      expect(tabIds(regionActiveRoot(transport.regionView()))).toEqual(["t1", "t3"]);
    });
    expect(tabIds(regionActiveRoot(currentLayoutView()))).toEqual(["t1", "t3"]);
    expect(tabIds(layoutState().rootPanel)).toEqual(["t1", "t3"]);
  });

  it("does not retry a rejected reconcile reseed forever (loop guard)", async () => {
    transport.seed(withLeafTabs(transport.regionView(), "a", [tab("t1"), tab("ghost")], "t1"));
    transport.reject = true;
    transport.dispatched.length = 0;
    for (let i = 0; i < 6; i++) await flushMacrotask();
    await new Promise((r) => setTimeout(r, 20));
    // One reconcile reseed attempted; its rejection re-emits the same dangling
    // view, which is logged but not reseeded again.
    expect(transport.kinds()).toEqual(["layout.replaceGroups"]);
    // The rendered tree is still a valid, reconciled one.
    expect(tabIds(layoutState().rootPanel)).toEqual(["t1", "t3"]);
  });

  it("keeps a late-arriving tab when its content catches up before the turn settles", async () => {
    const late = tab("late");
    transport.seed(withLeafTabs(transport.regionView(), "a", [tab("t1"), tab("t2"), late], "t1"));
    // Content arrives in the same turn (a transient desync, not a dangling ref).
    const { panelId: _p, isActive: _a, ...lateContent } = late;
    useAppStore.setState((s) => ({ tabContent: { ...s.tabContent, late: lateContent } }));
    expect(tabIds(layoutState().rootPanel)).toEqual(["t1", "t2", "late", "t3"]);

    await flush();
    await flushMacrotask();
    // No destructive reseed dropped it from the region.
    expect(tabIds(regionActiveRoot(transport.regionView()))).toEqual(["t1", "t2", "late", "t3"]);
    expect(tabIds(layoutState().rootPanel)).toEqual(["t1", "t2", "late", "t3"]);
  });

  it("does not compose a stale module-global tree for an unresolvable view", () => {
    const state = useAppStore.getState();
    const view = structuredClone(state.layoutView);
    const content = omit(state.tabContent, "t2");
    const composed = getComposedLayout({
      layoutView: view,
      tabContent: content,
      layoutSplitMarks: state.layoutSplitMarks,
    });
    // Derived from the inputs (t2 dropped), never the previous tree that still had t2.
    expect(tabIds(composed.rootPanel)).toEqual(["t1", "t3"]);
  });
});

describe("SM-024 — an empty / absent view keeps the last good tree", () => {
  it("ignores a view with no groups", async () => {
    const before = tabIds(layoutState().rootPanel);
    transport.seed({ groups: [], activeGroupId: "" });
    await flush();
    expect(tabIds(layoutState().rootPanel)).toEqual(before);
  });
});

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = map;
  return rest;
}
