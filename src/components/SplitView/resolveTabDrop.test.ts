/**
 * Table tests for the pure tab drag-and-drop routing extracted from
 * `SplitView.handleDragEnd` (TFE2-004, #4329).
 */
import { describe, it, expect } from "vitest";
import type { LeafPanel, PanelNode, TerminalTab } from "@/types/terminal";
import { describePointerHits, resolveTabDrop, type TabDropInput } from "./resolveTabDrop";

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

function input(partial: Partial<TabDropInput>): TabDropInput {
  return {
    tabId: "t1",
    fromPanelId: LEFT,
    overId: null,
    overPanelId: undefined,
    rootPanel: root,
    pointerHits: [],
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
  ])("%s", (_label, given, expected) => {
    expect(resolveTabDrop(given)).toEqual(expected);
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
