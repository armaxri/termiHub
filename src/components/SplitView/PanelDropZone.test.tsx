import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { PanelDropZone } from "./PanelDropZone";

const PANEL_ID = "panel-42";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function render(hideEdges: boolean) {
  act(() => {
    root.render(
      <DndContext>
        <PanelDropZone panelId={PANEL_ID} hideEdges={hideEdges} />
      </DndContext>
    );
  });
}

describe("PanelDropZone", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the four edge zones plus the center zone when edges are shown", () => {
    render(false);
    for (const edge of ["left", "right", "top", "bottom"]) {
      expect(query(`panel-drop-edge-${PANEL_ID}-${edge}`)).not.toBeNull();
    }
    expect(query(`panel-drop-center-${PANEL_ID}`)).not.toBeNull();
  });

  it("hides all edge zones but keeps the center zone when edges are hidden", () => {
    render(true);
    for (const edge of ["left", "right", "top", "bottom"]) {
      expect(query(`panel-drop-edge-${PANEL_ID}-${edge}`)).toBeNull();
    }
    expect(query(`panel-drop-center-${PANEL_ID}`)).not.toBeNull();
  });

  it("does not render a drop preview when nothing is hovered", () => {
    render(false);
    expect(container.querySelector(".panel-drop-zone__preview")).toBeNull();
  });

  it("scopes each edge test id to its panel id", () => {
    render(false);
    expect(query(`panel-drop-edge-${PANEL_ID}-left`)?.className).toContain(
      "panel-drop-zone__edge--left"
    );
  });
});
