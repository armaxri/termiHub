import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { useTreeSelection, TreeSelectionResult } from "./useTreeSelection";

function makeEvent(opts: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}) {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...opts,
  } as React.MouseEvent;
}

const FLAT = ["a", "b", "c", "d", "e"];

function SelectionHarness({
  flatIds,
  onResult,
}: {
  flatIds: string[];
  onResult: (r: TreeSelectionResult) => void;
}) {
  const result = useTreeSelection(flatIds);
  onResult(result);
  return null;
}

function DynamicHarness({
  onResult,
}: {
  onResult: (r: TreeSelectionResult, setFlat: (ids: string[]) => void) => void;
}) {
  const [flatIds, setFlatIds] = useState<string[]>(FLAT);
  const result = useTreeSelection(flatIds);
  onResult(result, setFlatIds);
  return null;
}

describe("useTreeSelection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: TreeSelectionResult;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("selects a single item on plain click", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent()));
    expect([...latest.selectedIds]).toEqual(["b"]);
  });

  it("toggles item on Ctrl+Click", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent({ ctrlKey: true })));
    act(() => latest.handleItemClick("c", makeEvent({ ctrlKey: true })));
    expect(latest.selectedIds.has("b")).toBe(true);
    expect(latest.selectedIds.has("c")).toBe(true);

    act(() => latest.handleItemClick("b", makeEvent({ ctrlKey: true })));
    expect(latest.selectedIds.has("b")).toBe(false);
    expect(latest.selectedIds.has("c")).toBe(true);
  });

  it("selects a range on Shift+Click", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent()));
    act(() => latest.handleItemClick("d", makeEvent({ shiftKey: true })));
    expect([...latest.selectedIds].sort()).toEqual(["b", "c", "d"]);
  });

  it("selects a reverse range on Shift+Click", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("d", makeEvent()));
    act(() => latest.handleItemClick("b", makeEvent({ shiftKey: true })));
    expect([...latest.selectedIds].sort()).toEqual(["b", "c", "d"]);
  });

  it("clears selection via clearSelection()", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent()));
    act(() => latest.clearSelection());
    expect(latest.selectedIds.size).toBe(0);
  });

  it("clears selection on Escape key", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent()));
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(latest.selectedIds.size).toBe(0);
  });

  it("clears selection when clicking empty area", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent()));
    const div = document.createElement("div");
    act(() => latest.handleAreaClick({ target: div } as unknown as React.MouseEvent));
    expect(latest.selectedIds.size).toBe(0);
  });

  it("does not clear selection when clicking a connection-tree__item", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("b", makeEvent()));
    const btn = document.createElement("button");
    btn.className = "connection-tree__item";
    document.body.appendChild(btn);
    act(() => latest.handleAreaClick({ target: btn } as unknown as React.MouseEvent));
    expect(latest.selectedIds.size).toBe(1);
    document.body.removeChild(btn);
  });

  it("removes Escape listener on unmount", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => root.unmount());
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function));
    removeSpy.mockRestore();
    // Prevent afterEach from double-unmounting
    root = createRoot(document.createElement("div"));
  });

  it("uses new anchor for next Shift+Click after plain click", () => {
    act(() => {
      root.render(
        createElement(SelectionHarness, { flatIds: FLAT, onResult: (r) => (latest = r) })
      );
    });
    act(() => latest.handleItemClick("a", makeEvent()));
    act(() => latest.handleItemClick("c", makeEvent({ shiftKey: true })));
    act(() => latest.handleItemClick("d", makeEvent()));
    act(() => latest.handleItemClick("e", makeEvent({ shiftKey: true })));
    expect([...latest.selectedIds].sort()).toEqual(["d", "e"]);
  });

  it("falls through to single select when Shift+Click with no anchor", () => {
    let setFlat!: (ids: string[]) => void;
    act(() => {
      root.render(
        createElement(DynamicHarness, {
          onResult: (r, s) => {
            latest = r;
            setFlat = s;
          },
        })
      );
    });
    act(() => latest.handleItemClick("c", makeEvent({ shiftKey: true })));
    expect([...latest.selectedIds]).toEqual(["c"]);
    void setFlat; // used to suppress unused var warning
  });
});
