---
id: TFE2-004
title: "SplitView drag-and-drop routing (handleDragEnd) is untested; SplitView is at 23% branch coverage"
angle: test-frontend
severity: low
category: test-gap
is_workaround: false
subsystem: "src/components/SplitView/SplitView.tsx"
evidence:
  - src/components/SplitView/SplitView.tsx:327-414
  - src/components/SplitView/SplitView.tsx:378-385
  - src/components/SplitView/SplitView.tsx:313-325
status: fixed
resolution: "#4329 — drop routing extracted to a pure resolveTabDrop with table tests"
audit: 2026-10
commit: 663465d52
relation: new
---

## What

SplitView.tsx has 92/395 branches covered (52% lines). The uncovered span includes all of `handleDragStart` and `handleDragEnd`: the elementsFromPoint scan that prefers a group chip over the new-group button, parsing `edge-{panelId}-{edge}` drop ids (panel ids may contain dashes), the center drop with its same-panel no-op, the cross-panel `moveTab` index lookup, and the same-panel `reorderTabs`. The zoom-overlay Escape handler is also uncovered. The four SplitView test files cover helpers, lazy surfaces, the resize handle and the terminal slot, but no drop routing. TFE-007 originally listed SplitView as a zero-test component; tests now exist, but its core logic is still unexercised.

## Why it matters

Every tab move, split and group change goes through this callback. A mis-parse of the edge id or a wrong index moves a tab to the wrong panel or splits the wrong side. With live terminals inside, that is a user-visible layout bug that no test would catch. The logic is pure decision-making trapped in a useCallback.

## Evidence

- `src/components/SplitView/SplitView.tsx:327-414`
- `src/components/SplitView/SplitView.tsx:378-385`
- `src/components/SplitView/SplitView.tsx:313-325`

## Recommendation

Extract `resolveTabDrop({ activeId, fromPanelId, overId, overPanelId, rootPanel, pointerHits }): DropAction` (a discriminated union: moveToGroup / newGroup / split(edge) / move(index) / reorder(old,new) / none) into a pure module. Table-test it, including dashed panel ids and the chip-vs-new-group-button precedence. handleDragEnd then becomes a thin dispatcher.

## Verification

Confirmed. The handleDragStart/handleDragEnd logic (edge-id parsing, center no-op, cross-panel moveTab index, reorder, elementsFromPoint chip precedence) is not exercised by any of the SplitView unit tests. Only PanelDropZone.test.tsx uses DndContext, and it does not cover routing. The system test test_tab_management.py::test_reorder_tabs_by_dragging covers same-panel reorder, but that lane is not per-PR, and edge-split and group-chip routing are untested anywhere. It is a real unit-test gap, but the impact is a layout bug with no data loss, so low rather than medium.
