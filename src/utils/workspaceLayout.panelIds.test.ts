import { describe, it, expect, vi } from "vitest";
import type { WorkspaceLayoutNode } from "@/types/workspace";

/**
 * Load a fresh, independent copy of the `workspaceLayout` module — the unit-test
 * analog of a second desktop window. Each desktop window runs its own JS context
 * with its own module-level state (formerly its own `ws-panel-N` counter);
 * `vi.resetModules()` plus a fresh dynamic import reproduces exactly that
 * isolation in one test process.
 */
async function freshWindowLayout() {
  vi.resetModules();
  const mod = await import("./workspaceLayout");
  return mod.buildPanelTreeFromWorkspace;
}

const leafLayout: WorkspaceLayoutNode = {
  type: "leaf",
  tabs: [{ initialCommand: undefined }],
};

describe("workspaceLayout — globally unique panel ids (#2868)", () => {
  it("two independent windows mint distinct ids for their first panel", async () => {
    const buildA = await freshWindowLayout();
    const buildB = await freshWindowLayout();

    const panelA = buildA(leafLayout, [], "zsh");
    const panelB = buildB(leafLayout, [], "zsh");

    // A per-window monotonic counter both starts at 0 and hands each window's
    // first panel `ws-panel-1`, colliding across windows. Because panel ids
    // double as layout/session-region keys, a collision lets a cross-window
    // operation target the wrong window's panel. Globally-unique ids make that
    // impossible.
    expect(panelA.id).not.toBe(panelB.id);
  });

  it("mints distinct ids for successive panels within one window", async () => {
    const build = await freshWindowLayout();

    const splitLayout: WorkspaceLayoutNode = {
      type: "split",
      direction: "horizontal",
      children: [leafLayout, leafLayout],
    };

    const tree = build(splitLayout, [], "zsh");
    expect(tree.type).toBe("split");
    if (tree.type === "split") {
      const ids = [tree.id, ...tree.children.map((child) => child.id)];
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("keeps the readable `ws-panel-` prefix so ids stay debuggable", async () => {
    const build = await freshWindowLayout();

    const panel = build(leafLayout, [], "zsh");

    expect(panel.id.startsWith("ws-panel-")).toBe(true);
  });
});
