import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import { PanelDropZone } from "./PanelDropZone";

// The droppable id dnd-kit reports the drag over; `null` = over nothing.
const dnd = vi.hoisted(() => ({ overId: null as string | null }));

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    useDroppable: (args: Parameters<typeof actual.useDroppable>[0]) => ({
      ...actual.useDroppable(args),
      isOver: args.id === dnd.overId,
    }),
  };
});

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
    dnd.overId = null;
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

  // The test bridge's dragTo releases only once the target reports the drag over
  // it; releasing earlier ended edge drops on the panel's own center (#5268).
  it("reports data-drop-over=false on every zone when nothing is hovered", () => {
    render(false);
    for (const edge of ["left", "right", "top", "bottom"]) {
      expect(query(`panel-drop-edge-${PANEL_ID}-${edge}`)?.getAttribute("data-drop-over")).toBe(
        "false"
      );
    }
    expect(query(`panel-drop-center-${PANEL_ID}`)?.getAttribute("data-drop-over")).toBe("false");
  });

  it("reports data-drop-over=true only on the zone dnd-kit has the drag over", () => {
    dnd.overId = `edge-${PANEL_ID}-right`;
    render(false);
    expect(query(`panel-drop-edge-${PANEL_ID}-right`)?.getAttribute("data-drop-over")).toBe("true");
    expect(query(`panel-drop-edge-${PANEL_ID}-left`)?.getAttribute("data-drop-over")).toBe("false");
    expect(query(`panel-drop-center-${PANEL_ID}`)?.getAttribute("data-drop-over")).toBe("false");
    expect(container.querySelector(".panel-drop-zone__preview--right")).not.toBeNull();
  });

  it("reports data-drop-over=true on the center zone when the drag is over it", () => {
    dnd.overId = `center-${PANEL_ID}`;
    render(false);
    expect(query(`panel-drop-center-${PANEL_ID}`)?.getAttribute("data-drop-over")).toBe("true");
  });
});
