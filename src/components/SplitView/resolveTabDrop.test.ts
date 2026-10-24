/**
 * Table tests for the pure tab drag-and-drop routing extracted from
 * `SplitView.handleDragEnd` (TFE2-004, #4329).
 */
import { describe, it, expect, vi } from "vitest";
import type { LeafPanel, PanelNode, TerminalTab } from "@/types/terminal";
import {
  describePointerHits,
  dispatchTabDrop,
  isOutsideViewport,
  resolveTabDrop,
  type TabDropInput,
  type TabDropOps,
} from "./resolveTabDrop";

function tab(id: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId,
    isActive: false,
  };
}

function leaf(id: string, tabIds: string[]): LeafPanel {
  return { type: "leaf", id, tabs: tabIds.map((t) => tab(t, id)), activeTabId: tabIds[0] ?? null };
}

// Panel ids deliberately contain dashes, as real generated ids do.
const LEFT = "panel-a-1";
const RIGHT = "panel-b-2";
const root: PanelNode = {
  type: "split",
  id: "split-root",
  direction: "horizontal",
  children: [leaf(LEFT, ["t1", "t2", "t3"]), leaf(RIGHT, ["u1", "u2"])],
};

const VIEWPORT = { width: 1280, height: 800 };

function input(partial: Partial<TabDropInput>): TabDropInput {
  return {
    tabId: "t1",
    fromPanelId: LEFT,
    overId: null,
    overPanelId: undefined,
    rootPanel: root,
    pointerHits: [],
    dropPoint: { x: 100, y: 100 },
    viewport: VIEWPORT,
    ...partial,
  };
}

describe("resolveTabDrop", () => {
  it.each([
    [
      "no source panel",
      input({ fromPanelId: undefined, overId: `center-${RIGHT}` }),
      { kind: "none" },
    ],
    ["dropped nowhere, nothing under the pointer", input({}), { kind: "none" }],
    [
      "dropped nowhere, over a group chip",
      input({ pointerHits: [{ tabGroupId: "grp-2", newGroupButton: false }] }),
      { kind: "moveToGroup", groupId: "grp-2" },
    ],
    [
      "dropped nowhere, over the new-group button",
      input({ pointerHits: [{ tabGroupId: null, newGroupButton: true }] }),
      { kind: "newGroup" },
    ],
    [
      "chip wins over the new-group button even when the button is hit first",
      input({
        pointerHits: [
          { tabGroupId: null, newGroupButton: true },
          { tabGroupId: "grp-3", newGroupButton: false },
        ],
      }),
      { kind: "moveToGroup", groupId: "grp-3" },
    ],
    [
      "edge drop with a dashed panel id",
      input({ overId: `edge-${RIGHT}-bottom` }),
      { kind: "split", targetPanelId: RIGHT, edge: "bottom" },
    ],
    [
      "edge drop onto the source panel itself",
      input({ overId: `edge-${LEFT}-right` }),
      { kind: "split", targetPanelId: LEFT, edge: "right" },
    ],
    [
      "center drop onto another panel",
      input({ overId: `center-${RIGHT}` }),
      { kind: "split", targetPanelId: RIGHT, edge: "center" },
    ],
    [
      "center drop onto the same panel is a no-op",
      input({ overId: `center-${LEFT}` }),
      { kind: "none" },
    ],
    [
      "cross-panel drop onto a tab inserts at that tab's index",
      input({ overId: "u2", overPanelId: RIGHT }),
      { kind: "move", toPanelId: RIGHT, index: 1 },
    ],
    [
      "cross-panel drop onto an unknown tab appends",
      input({ overId: "ghost", overPanelId: RIGHT }),
      { kind: "move", toPanelId: RIGHT, index: -1 },
    ],
    [
      "cross-panel drop into a missing panel",
      input({ overId: "x", overPanelId: "panel-gone" }),
      { kind: "none" },
    ],
    [
      "same-panel reorder",
      input({ overId: "t3", overPanelId: LEFT }),
      { kind: "reorder", panelId: LEFT, oldIndex: 0, newIndex: 2 },
    ],
    ["dropped onto itself", input({ overId: "t1", overPanelId: LEFT }), { kind: "none" }],
    [
      "same-panel drop onto a tab that is not there",
      input({ overId: "nope", overPanelId: LEFT }),
      { kind: "none" },
    ],
    // Tear-off (#4916): released outside the window opens it in a new window.
    [
      "released left of the window tears the tab off",
      input({ dropPoint: { x: -40, y: 200 } }),
      { kind: "tearOff" },
    ],
    [
      "released below the window tears the tab off",
      input({ dropPoint: { x: 300, y: 950 } }),
      { kind: "tearOff" },
    ],
    [
      "outside the window wins over a droppable the overlay still overlaps",
      input({ dropPoint: { x: 1290, y: 200 }, overId: `edge-${RIGHT}-right` }),
      { kind: "tearOff" },
    ],
    [
      "outside the window wins over a group chip at the clamped point",
      input({
        dropPoint: { x: 200, y: -5 },
        pointerHits: [{ tabGroupId: "grp-2", newGroupButton: false }],
      }),
      { kind: "tearOff" },
    ],
    [
      "outside the window with no source panel does nothing",
      input({ fromPanelId: undefined, dropPoint: { x: -40, y: 200 } }),
      { kind: "none" },
    ],
    [
      "unknown drop point (non-pointer sensor) never tears off",
      input({ dropPoint: null }),
      { kind: "none" },
    ],
    [
      "cancelled in-window release over a non-drop area is a no-op (MT-NIN-07)",
      input({ dropPoint: { x: 640, y: 400 } }),
      { kind: "none" },
    ],
  ])("%s", (_label, given, expected) => {
    expect(resolveTabDrop(given)).toEqual(expected);
  });
});

describe("isOutsideViewport", () => {
  it.each([
    [{ x: 0, y: 0 }, false],
    [{ x: 1279, y: 799 }, false],
    [{ x: 640, y: 400 }, false],
    [{ x: -1, y: 400 }, true],
    [{ x: 640, y: -1 }, true],
    [{ x: 1280, y: 400 }, true],
    [{ x: 640, y: 800 }, true],
  ])("%o -> %s", (point, expected) => {
    expect(isOutsideViewport(point, VIEWPORT)).toBe(expected);
  });

  it("treats a degenerate (zero-size) viewport as inside, never tearing off", () => {
    expect(isOutsideViewport({ x: 5, y: 5 }, { width: 0, height: 0 })).toBe(false);
  });
});

describe("dispatchTabDrop", () => {
  function ops(): TabDropOps {
    return {
      moveTabToGroup: vi.fn(),
      addTabGroupWithTab: vi.fn(),
      splitPanelWithTab: vi.fn(),
      moveTab: vi.fn(),
      reorderTabs: vi.fn(),
      moveTabToWindow: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("routes a tear-off through the existing move-to-new-window path", () => {
    const o = ops();
    dispatchTabDrop({ kind: "tearOff" }, "t1", LEFT, o);
    expect(o.moveTabToWindow).toHaveBeenCalledWith("t1", LEFT, { kind: "new" });
    expect(o.moveTab).not.toHaveBeenCalled();
  });

  it("does nothing for a no-op drop", () => {
    const o = ops();
    dispatchTabDrop({ kind: "none" }, "t1", LEFT, o);
    for (const fn of Object.values(o)) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "moveToGroup", groupId: "g" } as const, "moveTabToGroup", ["t1", LEFT, "g"]],
    [{ kind: "newGroup" } as const, "addTabGroupWithTab", ["t1", LEFT]],
    [
      { kind: "split", targetPanelId: RIGHT, edge: "left" } as const,
      "splitPanelWithTab",
      ["t1", LEFT, RIGHT, "left"],
    ],
    [{ kind: "move", toPanelId: RIGHT, index: 1 } as const, "moveTab", ["t1", LEFT, RIGHT, 1]],
    [
      { kind: "reorder", panelId: LEFT, oldIndex: 0, newIndex: 2 } as const,
      "reorderTabs",
      [LEFT, 0, 2],
    ],
  ])("routes %o to %s", (action, op, args) => {
    const o = ops();
    dispatchTabDrop(action, "t1", LEFT, o);
    expect(o[op as keyof TabDropOps]).toHaveBeenCalledWith(...args);
  });
});

describe("describePointerHits", () => {
  it("reads group-chip ids and the new-group marker from ancestor elements", () => {
    const bar = document.createElement("div");
    bar.innerHTML = `
      <button data-tab-group-id="grp-9"><span id="chip-label">Group</span></button>
      <button data-new-group-btn="true"><svg id="plus"></svg></button>
      <div id="other"></div>`;
    document.body.appendChild(bar);
    try {
      const hits = describePointerHits([
        bar.querySelector("#plus")!,
        bar.querySelector("#chip-label")!,
        bar.querySelector("#other")!,
      ]);
      expect(hits).toEqual([
        { tabGroupId: null, newGroupButton: true },
        { tabGroupId: "grp-9", newGroupButton: false },
        { tabGroupId: null, newGroupButton: false },
      ]);
    } finally {
      bar.remove();
    }
  });
});
