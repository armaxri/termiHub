/**
 * Split-guard tests (PROD-060): a pane may only be split when the resulting
 * panes stay at or above the minimum usable size, so splitting can never produce
 * an unusable sliver. Exercises the pure `panelTree` helpers directly.
 */
import { describe, it, expect } from "vitest";
import type { LeafPanel, PanelNode, SplitContainer } from "@/types/terminal";
import { canSplitLeaf, leafSizePercent, MIN_USABLE_PANE_PERCENT } from "./panelTree";

function leaf(id: string): LeafPanel {
  return { type: "leaf", id, tabs: [], activeTabId: null };
}

function split(
  id: string,
  direction: "horizontal" | "vertical",
  children: PanelNode[],
  sizes?: number[]
): SplitContainer {
  return { type: "split", id, direction, children, ...(sizes ? { sizes } : {}) };
}

describe("leafSizePercent (PROD-060)", () => {
  it("reports the whole window for a sole root leaf", () => {
    expect(leafSizePercent(leaf("solo"), "solo")).toBe(100);
  });

  it("divides evenly when a container has no explicit sizes", () => {
    const root = split("s", "horizontal", [leaf("a"), leaf("b")]);
    expect(leafSizePercent(root, "a")).toBe(50);
    expect(leafSizePercent(root, "b")).toBe(50);
  });

  it("follows explicit sizes and multiplies through nested splits", () => {
    const inner = split("inner", "vertical", [leaf("a"), leaf("b")], [50, 50]);
    const root = split("root", "horizontal", [inner, leaf("c")], [20, 80]);
    // a is 50% of the 20% inner slot = 10% of the window.
    expect(leafSizePercent(root, "a")).toBeCloseTo(10);
    expect(leafSizePercent(root, "c")).toBeCloseTo(80);
  });

  it("returns 0 for a leaf that is not present", () => {
    expect(leafSizePercent(leaf("solo"), "missing")).toBe(0);
  });
});

describe("canSplitLeaf (PROD-060)", () => {
  it("allows splitting a full-window pane", () => {
    expect(canSplitLeaf(leaf("solo"), "solo")).toBe(true);
  });

  it("allows a normal split when both halves stay usable", () => {
    // A 50% pane halves to 25% — well above the minimum.
    const root = split("s", "horizontal", [leaf("a"), leaf("b")], [50, 50]);
    expect(canSplitLeaf(root, "a")).toBe(true);
  });

  it("blocks a split that would create a sub-minimum sliver", () => {
    // "a" is only 2×MIN − a hair of the window, so half of it falls below the
    // minimum usable size and the split must be refused.
    const tiny = MIN_USABLE_PANE_PERCENT * 2 - 1;
    const root = split("s", "horizontal", [leaf("a"), leaf("b")], [tiny, 100 - tiny]);
    expect(canSplitLeaf(root, "a")).toBe(false);
    // Its large sibling can still be split.
    expect(canSplitLeaf(root, "b")).toBe(true);
  });

  it("blocks at the boundary and allows just above it", () => {
    const atFloor = split(
      "s",
      "horizontal",
      [leaf("a"), leaf("b")],
      [MIN_USABLE_PANE_PERCENT * 2 - 0.001, 100 - (MIN_USABLE_PANE_PERCENT * 2 - 0.001)]
    );
    expect(canSplitLeaf(atFloor, "a")).toBe(false);

    const justAbove = split(
      "s",
      "horizontal",
      [leaf("a"), leaf("b")],
      [MIN_USABLE_PANE_PERCENT * 2, 100 - MIN_USABLE_PANE_PERCENT * 2]
    );
    expect(canSplitLeaf(justAbove, "a")).toBe(true);
  });

  it("treats a missing leaf as un-splittable", () => {
    expect(canSplitLeaf(leaf("solo"), "missing")).toBe(false);
  });
});
