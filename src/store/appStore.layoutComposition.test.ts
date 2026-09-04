/**
 * Region-derived layout composition (#2562) — the two residual risks the
 * mirror-field deletion had to guard:
 *
 *  1. **Ref stability / no render storm.** `getComposedLayout` memoizes on the
 *     identities of `layoutView` / `tabContent` / `layoutSplitMarks`, so an
 *     unrelated store change must return the *same* composed object — otherwise
 *     every layout consumer re-renders on every store write.
 *  2. **Directional split-nav marks are current, not one-op-stale.** The `#448`
 *     marks moved out of the layout tree into `layoutSplitMarks`; they must track
 *     the *current* active panel synchronously after each navigation op (the old
 *     compose-time re-application lagged by one op).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

import type { PanelNode, TerminalTab } from "@/types/terminal";
import { findLeaf, getAllLeaves } from "@/utils/panelTree";
import { getComposedLayout, useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";

function tab(id: string): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "p",
    isActive: false,
  };
}

function leaf(id: string, tabs: TerminalTab[]): PanelNode {
  return { type: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

/** A horizontal split of two single-tab leaves `a` and `b`. */
function splitRoot(): PanelNode {
  return {
    type: "split",
    id: "root",
    direction: "horizontal",
    children: [leaf("a", [tab("t1")]), leaf("b", [tab("t2")])],
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("layout composition — ref stability (#2562)", () => {
  it("returns the SAME composed object across an unrelated store change", () => {
    seedLayoutState({ rootPanel: splitRoot(), activePanelId: "a" });

    const before = getComposedLayout(useAppStore.getState());
    // A change that touches none of layoutView / tabContent / layoutSplitMarks.
    useAppStore.setState({ sidebarCollapsed: !useAppStore.getState().sidebarCollapsed });
    const after = getComposedLayout(useAppStore.getState());

    // Same object reference — the memoization guards against a render storm.
    expect(after).toBe(before);
    expect(after.rootPanel).toBe(before.rootPanel);
    expect(after.tabGroups).toBe(before.tabGroups);
  });

  it("returns a NEW composed object when the layout view changes", () => {
    seedLayoutState({ rootPanel: leaf("A", [tab("t1")]), activePanelId: "A" });
    const before = getComposedLayout(useAppStore.getState());

    seedLayoutState({ rootPanel: leaf("B", [tab("t2")]), activePanelId: "B" });
    const after = getComposedLayout(useAppStore.getState());

    expect(after).not.toBe(before);
    expect(after.rootPanel.id).toBe("B");
  });

  it("returns a NEW composed object when tab content changes", () => {
    seedLayoutState({ rootPanel: leaf("A", [tab("t1")]), activePanelId: "A" });
    const before = getComposedLayout(useAppStore.getState());

    // A content mutation (title) flows through tabContent, so the composed tree
    // legitimately changes — a new ref is correct here.
    useAppStore.getState().renameTab("t1", "Renamed");
    const after = getComposedLayout(useAppStore.getState());

    expect(after).not.toBe(before);
    expect(getAllLeaves(after.rootPanel)[0].tabs[0].title).toBe("Renamed");
  });
});

describe("layout composition — directional split marks are current (#448 / #2562)", () => {
  it("marks the ancestor split at the CURRENT active panel after each nav op", () => {
    seedLayoutState({ rootPanel: splitRoot(), activePanelId: "a" });

    // Focus b: the root split's directional mark must point at b immediately.
    useAppStore.getState().setActivePanel("b");
    const groupId = layoutState().activeTabGroupId;
    expect(useAppStore.getState().layoutSplitMarks[groupId]?.root).toBe("b");
    // And the composed tree carries the same (current) mark — not one-op stale.
    {
      const root = layoutState().rootPanel;
      expect(root.type === "split" && root.lastActiveLeafId).toBe("b");
    }

    // Focus a: the mark must update to a on THIS op (no lag).
    useAppStore.getState().setActivePanel("a");
    expect(useAppStore.getState().layoutSplitMarks[groupId]?.root).toBe("a");
    {
      const root = layoutState().rootPanel;
      expect(root.type === "split" && root.lastActiveLeafId).toBe("a");
      // Sanity: the focused panel really is the marked one.
      expect(findLeaf(root, "a")).not.toBeNull();
    }
  });

  it("keeps the mark out of the appStore layout mirror fields (they no longer exist)", () => {
    seedLayoutState({ rootPanel: splitRoot(), activePanelId: "a" });
    useAppStore.getState().setActivePanel("b");

    const state = useAppStore.getState() as unknown as Record<string, unknown>;
    // The four region-derived mirror fields are gone; only the raw view + marks remain.
    expect(state.rootPanel).toBeUndefined();
    expect(state.tabGroups).toBeUndefined();
    expect(state.activePanelId).toBeUndefined();
    expect(state.activeTabGroupId).toBeUndefined();
    expect(state.layoutView).toBeDefined();
    expect(state.layoutSplitMarks).toBeDefined();
  });
});
