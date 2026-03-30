import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { useSectionResize } from "./useSectionResize";

// A component that renders the hook with a dynamic expandedCount
// and exposes the result via a callback.
function ResizeHarness({
  initialCount,
  onResult,
}: {
  initialCount: number;
  onResult: (r: ReturnType<typeof useSectionResize>) => void;
}) {
  const [count] = useState(initialCount);
  const result = useSectionResize(count);
  onResult(result);
  return null;
}

// A component that allows changing expandedCount from outside
function DynamicResizeHarness({
  onResult,
}: {
  onResult: (r: ReturnType<typeof useSectionResize>, setCount: (n: number) => void) => void;
}) {
  const [count, setCount] = useState(2);
  const result = useSectionResize(count);
  onResult(result, setCount);
  return null;
}

describe("useSectionResize", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  describe("initial state", () => {
    it("initializes flex values to all-ones for the given count", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 3, onResult: (r) => (result = r) })
        );
      });

      expect(result!.flexValues).toEqual([1, 1, 1]);
    });

    it("handles a single section (count=1)", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 1, onResult: (r) => (result = r) })
        );
      });

      expect(result!.flexValues).toEqual([1]);
    });

    it("isResizing starts as false", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 2, onResult: (r) => (result = r) })
        );
      });

      expect(result!.isResizing).toBe(false);
    });
  });

  describe("flex value reset on expandedCount change", () => {
    it("resets to all-ones when expandedCount increases", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;
      let setCount!: (n: number) => void;

      act(() => {
        root.render(
          createElement(DynamicResizeHarness, {
            onResult: (r, sc) => {
              result = r;
              setCount = sc;
            },
          })
        );
      });

      expect(result!.flexValues).toEqual([1, 1]);

      act(() => setCount(4));

      expect(result!.flexValues).toEqual([1, 1, 1, 1]);
    });

    it("resets to all-ones when expandedCount decreases", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;
      let setCount!: (n: number) => void;

      act(() => {
        root.render(
          createElement(DynamicResizeHarness, {
            onResult: (r, sc) => {
              result = r;
              setCount = sc;
            },
          })
        );
      });

      act(() => setCount(1));

      expect(result!.flexValues).toEqual([1]);
    });
  });

  describe("handleProps", () => {
    it("returns onMouseDown handler for a given index", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 2, onResult: (r) => (result = r) })
        );
      });

      const props = result!.handleProps(0);
      expect(typeof props.onMouseDown).toBe("function");
    });
  });

  describe("mouse drag", () => {
    it("sets isResizing to true on mousedown (when sections have height)", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 2, onResult: (r) => (result = r) })
        );
      });

      // Attach real DOM elements to sectionRefs so the drag can read heights
      const above = document.createElement("div");
      const below = document.createElement("div");
      Object.defineProperty(above, "getBoundingClientRect", {
        value: () => ({ height: 200 }),
      });
      Object.defineProperty(below, "getBoundingClientRect", {
        value: () => ({ height: 200 }),
      });
      result!.sectionRefs.current[0] = above;
      result!.sectionRefs.current[1] = below;

      const props = result!.handleProps(0);
      act(() => {
        props.onMouseDown({ clientY: 100, preventDefault: vi.fn() } as unknown as React.MouseEvent);
      });

      expect(result!.isResizing).toBe(true);

      // Clean up — fire mouseup to release listeners
      act(() => {
        document.dispatchEvent(new MouseEvent("mouseup"));
      });
    });

    it("adjusts flex values when dragging down", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 2, onResult: (r) => (result = r) })
        );
      });

      const above = document.createElement("div");
      const below = document.createElement("div");
      Object.defineProperty(above, "getBoundingClientRect", {
        value: () => ({ height: 100 }),
      });
      Object.defineProperty(below, "getBoundingClientRect", {
        value: () => ({ height: 100 }),
      });
      result!.sectionRefs.current[0] = above;
      result!.sectionRefs.current[1] = below;

      const props = result!.handleProps(0);
      act(() => {
        props.onMouseDown({ clientY: 100, preventDefault: vi.fn() } as unknown as React.MouseEvent);
      });

      // Drag 50px down: above grows, below shrinks
      act(() => {
        document.dispatchEvent(new MouseEvent("mousemove", { clientY: 150 }));
      });

      const [flexAbove, flexBelow] = result!.flexValues;
      expect(flexAbove).toBeGreaterThan(1);
      expect(flexBelow).toBeLessThan(1);
      expect(flexAbove + flexBelow).toBeCloseTo(2, 5);

      act(() => {
        document.dispatchEvent(new MouseEvent("mouseup"));
      });
    });

    it("enforces minimum flex value (MIN_FLEX = 0.1)", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 2, onResult: (r) => (result = r) })
        );
      });

      const above = document.createElement("div");
      const below = document.createElement("div");
      Object.defineProperty(above, "getBoundingClientRect", {
        value: () => ({ height: 100 }),
      });
      Object.defineProperty(below, "getBoundingClientRect", {
        value: () => ({ height: 100 }),
      });
      result!.sectionRefs.current[0] = above;
      result!.sectionRefs.current[1] = below;

      const props = result!.handleProps(0);
      act(() => {
        props.onMouseDown({ clientY: 100, preventDefault: vi.fn() } as unknown as React.MouseEvent);
      });

      // Drag very far down (200px out of 200 total) — should clamp below to MIN_FLEX
      act(() => {
        document.dispatchEvent(new MouseEvent("mousemove", { clientY: 500 }));
      });

      const [, flexBelow] = result!.flexValues;
      expect(flexBelow).toBeGreaterThanOrEqual(0.1);

      act(() => {
        document.dispatchEvent(new MouseEvent("mouseup"));
      });
    });

    it("releases listeners and resets isResizing on mouseup", () => {
      let result: ReturnType<typeof useSectionResize> | undefined;

      act(() => {
        root.render(
          createElement(ResizeHarness, { initialCount: 2, onResult: (r) => (result = r) })
        );
      });

      const above = document.createElement("div");
      const below = document.createElement("div");
      Object.defineProperty(above, "getBoundingClientRect", { value: () => ({ height: 100 }) });
      Object.defineProperty(below, "getBoundingClientRect", { value: () => ({ height: 100 }) });
      result!.sectionRefs.current[0] = above;
      result!.sectionRefs.current[1] = below;

      act(() => {
        result!.handleProps(0).onMouseDown({
          clientY: 100,
          preventDefault: vi.fn(),
        } as unknown as React.MouseEvent);
      });
      expect(result!.isResizing).toBe(true);

      act(() => {
        document.dispatchEvent(new MouseEvent("mouseup"));
      });

      expect(result!.isResizing).toBe(false);
    });
  });
});
