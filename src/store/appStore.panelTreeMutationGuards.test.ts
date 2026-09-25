/**
 * Branch-coverage suite (TFE-005 / #3217) for the missing-entity and
 * pane-too-small guard branches in `appStore`'s panel-tree mutation actions that
 * the existing layout suites leave dark:
 *
 *  - `moveTab`: the `!sourceLeaf` (stale drag-source panel) and `!tab` (stale
 *    drag tab id) early returns, plus the same-panel no-op.
 *  - `splitPanel` / `splitPanelWithTab`: the PROD-060 "pane too small to split"
 *    soft guard (toast + no-op) on both the keyboard split and the edge-drop.
 *  - `splitPanelWithTab`: the center-drop and edge-drop `!sourceLeaf` / `!tab`
 *    early returns.
 *  - `moveTabToGroup`: the `!sourceLeaf`, `!tab`, unknown-target-group and
 *    empty-target-group (`!targetLeaf`) early returns — a stray drag id must
 *    never mint or mutate a group.
 *
 * Every branch here is a defensive bail-out whose contract is "leave the layout
 * exactly as it was" (optionally with a recoverable toast), so each test asserts
 * the observable outcome — the composed tree is unchanged — rather than any
 * internal. These actions operate purely on the composed layout, so the suite
 * needs no service mocks beyond the theme side-effect stub and a toast spy.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const toastError = vi.fn();
vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { loading: vi.fn(), success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
  };
});

import { useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { getAllLeaves } from "@/utils/panelTree";
import type {
  ConnectionConfig,
  LeafPanel,
  PanelNode,
  TabGroup,
  TerminalTab,
} from "@/types/terminal";

const LOCAL_CONFIG: ConnectionConfig = { type: "local", config: { shell: "zsh" } };

function termTab(id: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: LOCAL_CONFIG,
    panelId,
    isActive: false,
  } as TerminalTab;
}

function leaf(id: string, tabs: TerminalTab[]): LeafPanel {
  return { type: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

/** A single tab group holding the given root panel. */
function group(rootPanel: PanelNode, activePanelId: string): TabGroup[] {
  return [{ id: "g1", name: "Main", rootPanel, activePanelId }];
}

/** Ids of every tab across the composed layout, panel-by-panel — the shape a
 * "layout unchanged" assertion compares against. */
function layoutShape(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const l of getAllLeaves(layoutState().rootPanel)) out[l.id] = l.tabs.map((t) => t.id);
  return out;
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

describe("appStore.moveTab — missing-entity guards", () => {
  // A two-panel layout: pA holds t1, pB is empty.
  function seedTwoPanel(): void {
    const root: PanelNode = {
      type: "split",
      id: "r",
      direction: "horizontal",
      children: [leaf("pA", [termTab("t1", "pA")]), leaf("pB", [])],
      sizes: [50, 50],
    };
    seedLayoutState({
      rootPanel: root,
      activePanelId: "pA",
      tabGroups: group(root, "pA"),
      activeTabGroupId: "g1",
    });
  }

  it("is a no-op when the source panel no longer exists (!sourceLeaf)", () => {
    seedTwoPanel();
    const before = layoutShape();

    useAppStore.getState().moveTab("t1", "gone-panel", "pB", -1);

    expect(layoutShape()).toEqual(before);
  });

  it("is a no-op when the dragged tab is not in the source panel (!tab)", () => {
    seedTwoPanel();
    const before = layoutShape();

    useAppStore.getState().moveTab("gone-tab", "pA", "pB", -1);

    expect(layoutShape()).toEqual(before);
  });

  it("is a no-op when source and target panel are the same", () => {
    seedTwoPanel();
    const before = layoutShape();

    useAppStore.getState().moveTab("t1", "pA", "pA", -1);

    expect(layoutShape()).toEqual(before);
  });
});

describe("appStore.splitPanel — pane-too-small soft guard (PROD-060)", () => {
  it("refuses to split a pane already below the minimum share and surfaces a toast", () => {
    // pSmall holds only 5% of the width — half of that is below MIN_USABLE_PANE_PERCENT.
    const root: PanelNode = {
      type: "split",
      id: "r",
      direction: "horizontal",
      children: [
        leaf("pBig", [termTab("tBig", "pBig")]),
        leaf("pSmall", [termTab("tSmall", "pSmall")]),
      ],
      sizes: [95, 5],
    };
    seedLayoutState({
      rootPanel: root,
      activePanelId: "pSmall",
      tabGroups: group(root, "pSmall"),
      activeTabGroupId: "g1",
    });
    const before = layoutShape();

    useAppStore.getState().splitPanel("horizontal");

    expect(toastError).toHaveBeenCalledWith("Pane too small to split further");
    expect(layoutShape()).toEqual(before); // no new empty leaf minted
  });
});

describe("appStore.splitPanelWithTab — guards", () => {
  function seedTwoPanel(): PanelNode {
    const root: PanelNode = {
      type: "split",
      id: "r",
      direction: "horizontal",
      children: [leaf("pA", [termTab("t1", "pA")]), leaf("pB", [termTab("t2", "pB")])],
      sizes: [50, 50],
    };
    seedLayoutState({
      rootPanel: root,
      activePanelId: "pA",
      tabGroups: group(root, "pA"),
      activeTabGroupId: "g1",
    });
    return root;
  }

  it("center-drop is a no-op when the source panel is gone (!sourceLeaf)", () => {
    seedTwoPanel();
    const before = layoutShape();
    useAppStore.getState().splitPanelWithTab("t1", "gone-panel", "pB", "center");
    expect(layoutShape()).toEqual(before);
  });

  it("center-drop is a no-op when the dragged tab is gone (!tab)", () => {
    seedTwoPanel();
    const before = layoutShape();
    useAppStore.getState().splitPanelWithTab("gone-tab", "pA", "pB", "center");
    expect(layoutShape()).toEqual(before);
  });

  it("edge-drop is a no-op when the source panel is gone (!sourceLeaf)", () => {
    seedTwoPanel();
    const before = layoutShape();
    useAppStore.getState().splitPanelWithTab("t1", "gone-panel", "pB", "right");
    expect(layoutShape()).toEqual(before);
  });

  it("edge-drop is a no-op when the dragged tab is gone (!tab)", () => {
    seedTwoPanel();
    const before = layoutShape();
    useAppStore.getState().splitPanelWithTab("gone-tab", "pA", "pB", "right");
    expect(layoutShape()).toEqual(before);
  });

  it("edge-drop onto a pane too small to split surfaces a toast and does not split", () => {
    const root: PanelNode = {
      type: "split",
      id: "r",
      direction: "horizontal",
      children: [
        leaf("pBig", [termTab("tBig", "pBig")]),
        leaf("pSmall", [termTab("tSmall", "pSmall")]),
      ],
      sizes: [95, 5],
    };
    seedLayoutState({
      rootPanel: root,
      activePanelId: "pBig",
      tabGroups: group(root, "pBig"),
      activeTabGroupId: "g1",
    });
    const before = layoutShape();

    useAppStore.getState().splitPanelWithTab("tBig", "pBig", "pSmall", "right");

    expect(toastError).toHaveBeenCalledWith("Pane too small to split further");
    expect(layoutShape()).toEqual(before);
  });
});

describe("appStore.moveTabToGroup — guards", () => {
  // Two groups: g1 (active) has pA→t1; g2 has qA (empty leaf).
  function seedTwoGroups(g2Root: PanelNode): void {
    const g1Root: PanelNode = leaf("pA", [termTab("t1", "pA")]);
    useAppStore.setState(useAppStore.getInitialState());
    seedLayoutState({
      rootPanel: g1Root,
      activePanelId: "pA",
      tabGroups: [
        { id: "g1", name: "Main", rootPanel: g1Root, activePanelId: "pA" },
        {
          id: "g2",
          name: "Other",
          rootPanel: g2Root,
          activePanelId: getAllLeaves(g2Root)[0]?.id ?? null,
        },
      ],
      activeTabGroupId: "g1",
    });
  }

  it("is a no-op when the source panel is gone (!sourceLeaf)", () => {
    seedTwoGroups(leaf("qA", []));
    const before = layoutShape();
    useAppStore.getState().moveTabToGroup("t1", "gone-panel", "g2");
    expect(layoutShape()).toEqual(before);
  });

  it("is a no-op when the dragged tab is gone (!tab)", () => {
    seedTwoGroups(leaf("qA", []));
    const before = layoutShape();
    useAppStore.getState().moveTabToGroup("gone-tab", "pA", "g2");
    expect(layoutShape()).toEqual(before);
  });

  it("is a no-op when the target group does not exist", () => {
    seedTwoGroups(leaf("qA", []));
    const t1BeforeGroups = layoutState().tabGroups.map((g) => ({
      id: g.id,
      tabs: getAllLeaves(g.rootPanel).flatMap((l) => l.tabs.map((t) => t.id)),
    }));
    useAppStore.getState().moveTabToGroup("t1", "pA", "no-such-group");
    const after = layoutState().tabGroups.map((g) => ({
      id: g.id,
      tabs: getAllLeaves(g.rootPanel).flatMap((l) => l.tabs.map((t) => t.id)),
    }));
    expect(after).toEqual(t1BeforeGroups);
  });

  it("is a no-op when the target group has no leaf to receive the tab (!targetLeaf)", () => {
    // A malformed target group whose root split has no leaf children.
    const emptySplit: PanelNode = {
      type: "split",
      id: "qsplit",
      direction: "horizontal",
      children: [],
    };
    seedTwoGroups(emptySplit);
    // t1 must still be present in the active group (nothing moved out).
    expect(getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs.map((t) => t.id))).toContain(
      "t1"
    );

    useAppStore.getState().moveTabToGroup("t1", "pA", "g2");

    expect(getAllLeaves(layoutState().rootPanel).flatMap((l) => l.tabs.map((t) => t.id))).toContain(
      "t1"
    );
  });
});
