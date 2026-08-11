/**
 * appStore ↔ layout projection bridge wiring (#2283 slice D' — the un-gated
 * optimistic-fold overlay).
 *
 * Drives the layout reducers through the **real**
 * {@link import("./layoutBridge").mirrorLayoutIntent} path against an in-memory
 * backend double ({@link FakeLayoutTransport}) that folds the granular `layout.*`
 * intents like the Rust store. It pins the slice's contract:
 *
 * - the local reducer stays authoritative and **synchronous** — `appStore.rootPanel`
 *   updates at once (the timing win: no seed→await→reconcile round-trip);
 * - the same transition is mirrored into the region **synchronously** via an
 *   optimistic overlay, then reconciled when the backend's diff lands;
 * - a rejected dispatch rolls the overlay back while `appStore` keeps the local
 *   result — the retained instant-revert fallback (#2283 removal stays gated);
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
import {
  currentLayoutView,
  ensureLayoutRegionClient,
  setLayoutIntentsEnabled,
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

async function resetStore(root: PanelNode = seedTree(), activePanelId = "a"): Promise<void> {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({ rootPanel: root, activePanelId });
}

beforeEach(async () => {
  ({ transport, teardown } = installLayoutHarness());
  setLayoutIntentsEnabled(null);
  await resetStore();
  // Pre-subscribe so the region's initial snapshot is adopted before any reducer
  // dispatch — the fake fans snapshots synchronously, so subscribing first keeps
  // versions monotonic (production's real transport is naturally ordered).
  await ensureLayoutRegionClient();
});

afterEach(() => {
  setLayoutIntentsEnabled(null);
  teardown();
});

describe("slice D' — synchronous local authority + optimistic region overlay", () => {
  it("flag off: splitPanel mutates locally and dispatches nothing", () => {
    setLayoutIntentsEnabled(false);
    useAppStore.getState().splitPanel("vertical");

    expect(transport.kinds()).toHaveLength(0);
    expect(getAllLeaves(useAppStore.getState().rootPanel)).toHaveLength(3);
  });

  it("flag on: splitPanel applies to rootPanel SYNCHRONOUSLY (no await)", () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().splitPanel("vertical");
    // No flush: the local reducer is the authoritative, synchronous writer.
    expect(getAllLeaves(useAppStore.getState().rootPanel)).toHaveLength(3);
  });

  it("flag on: the region overlay reflects the split SYNCHRONOUSLY, before any ack", () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().splitPanel("vertical");
    // The optimistic overlay installs appStore's post-split tree at once.
    const root = regionActiveRoot(currentLayoutView());
    expect(root && getAllLeaves(root)).toHaveLength(3);
  });

  it("flag on: dispatches replaceGroups (seed) then the granular layout.split", async () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().splitPanel("vertical");
    await flush();
    expect(transport.kinds()).toEqual(["layout.replaceGroups", "layout.split"]);
    expect(transport.dispatched[1].payload).toMatchObject({
      panelId: "a",
      direction: "vertical",
      position: "after",
    });
  });

  it("reconcile: the backend converges to the same tab layout after the diff lands", async () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().reorderTabs("a", 0, 1);
    await flush();
    // Non-id-generating op: the backend's authoritative view matches appStore.
    const backendRoot = regionActiveRoot(transport.regionView())!;
    expect(tabIds(backendRoot)).toEqual(tabIds(useAppStore.getState().rootPanel));
    // …and the client's effective view reconciled to it (overlay pruned).
    expect(tabIds(regionActiveRoot(currentLayoutView())!)).toEqual(
      tabIds(useAppStore.getState().rootPanel)
    );
  });

  it("rejected dispatch: overlay rolls back, appStore keeps the local result (fallback retained)", async () => {
    setLayoutIntentsEnabled(true);
    transport.reject = true;
    useAppStore.getState().splitPanel("vertical");
    // Local reducer already applied the split (authoritative + instant).
    expect(getAllLeaves(useAppStore.getState().rootPanel)).toHaveLength(3);
    await flush();
    // Still split locally — the retained fallback held through the rejection.
    expect(getAllLeaves(useAppStore.getState().rootPanel)).toHaveLength(3);
    // The optimistic overlay was rolled back (region did not adopt the change).
    const root = regionActiveRoot(currentLayoutView());
    expect(root && getAllLeaves(root).length).toBeLessThan(3);
  });
});

describe("slice D' — every listed op routes its granular intent", () => {
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
      name: "splitPanelWithTab (move)",
      run: () => useAppStore.getState().splitPanelWithTab("t1", "a", "b", "center"),
      kind: "layout.moveTab",
    },
    {
      name: "addTabGroup",
      run: () => useAppStore.getState().addTabGroup("Extra"),
      kind: "layout.addGroup",
    },
    {
      name: "renameTabGroup",
      run: () => {
        const gid = useAppStore.getState().activeTabGroupId;
        useAppStore.getState().renameTabGroup(gid, "Renamed");
      },
      kind: "layout.renameGroup",
    },
    {
      name: "setTabGroupColor",
      run: () => {
        const gid = useAppStore.getState().activeTabGroupId;
        useAppStore.getState().setTabGroupColor(gid, "#abcdef");
      },
      kind: "layout.setGroupColor",
    },
  ];

  for (const c of cases) {
    it(`${c.name} dispatches ${c.kind}`, async () => {
      setLayoutIntentsEnabled(true);
      c.run();
      await flush();
      expect(transport.kinds()).toContain(c.kind);
    });
  }

  it("addTab dispatches layout.addTab carrying the frontend-generated tab id", async () => {
    setLayoutIntentsEnabled(true);
    const id = useAppStore.getState().addTab("New", "local", { type: "local", config: {} });
    await flush();
    const add = transport.dispatched.find((d) => d.kind === "layout.addTab");
    expect(add).toBeDefined();
    expect((add!.payload as { tab: { id: string } }).tab.id).toBe(id);
  });

  it("closeTab dispatches layout.closeTabStructure", async () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().closeTab("t2", "a");
    await flush();
    expect(transport.kinds()).toContain("layout.closeTabStructure");
  });

  it("setActiveTab activates the tab in both appStore and the region", async () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().setActiveTab("t2", "a");
    await flush();
    expect(findLeaf(useAppStore.getState().rootPanel, "a")!.activeTabId).toBe("t2");
    const regionA = findLeaf(regionActiveRoot(transport.regionView())!, "a");
    expect(regionA!.activeTabId).toBe("t2");
  });
});

describe("slice D' — tab id preservation (no live-terminal remount)", () => {
  it("split preserves every existing tab id", () => {
    setLayoutIntentsEnabled(true);
    const before = tabIds(useAppStore.getState().rootPanel);
    useAppStore.getState().splitPanel("vertical");
    expect(tabIds(useAppStore.getState().rootPanel)).toEqual(before);
  });

  it("drag-move (center) preserves the moved tab id and its stack neighbours", () => {
    setLayoutIntentsEnabled(true);
    useAppStore.getState().splitPanelWithTab("t1", "a", "b", "center");
    const ids = tabIds(useAppStore.getState().rootPanel).sort();
    expect(ids).toEqual(["t1", "t2", "t3"]);
  });

  it("group switch keeps each group's tab ids intact", async () => {
    setLayoutIntentsEnabled(true);
    // The seed tree lives in the first group. Add a fresh (empty) group — which
    // becomes active — then switch back to the first and assert its tabs survived.
    useAppStore.getState().addTabGroup("G2");
    await flush();
    const firstGroup = useAppStore.getState().tabGroups[0].id;
    useAppStore.getState().setActiveTabGroup(firstGroup);
    await flush();
    expect(tabIds(useAppStore.getState().rootPanel).sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("tab activation never changes tab ids, only the active flag", () => {
    setLayoutIntentsEnabled(true);
    const before = tabIds(useAppStore.getState().rootPanel);
    useAppStore.getState().setActiveTab("t2", "a");
    expect(tabIds(useAppStore.getState().rootPanel)).toEqual(before);
    expect(findLeaf(useAppStore.getState().rootPanel, "a")!.activeTabId).toBe("t2");
  });
});
