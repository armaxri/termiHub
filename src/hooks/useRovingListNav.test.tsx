import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, Root } from "react-dom/client";
import { useRovingListNav, RovingListNav, RovingListNavCallbacks } from "./useRovingListNav";

interface Item {
  name: string;
}

const ITEMS: Item[] = [
  { name: "alpha" },
  { name: "apple" },
  { name: "banana" },
  { name: "cherry" },
];

/** Build a fully-spied callbacks object with sensible no-op defaults. */
function makeCallbacks(
  overrides: Partial<RovingListNavCallbacks<Item>> = {}
): RovingListNavCallbacks<Item> {
  return {
    onActivate: vi.fn(),
    onNavigateUp: vi.fn(),
    onRename: vi.fn(),
    onSelectAll: vi.fn(),
    onClearSelection: vi.fn(),
    getAnchorIndex: vi.fn(() => -1),
    onSelectRange: vi.fn(),
    onSelectSingle: vi.fn(),
    ...overrides,
  };
}

/**
 * Minimal list harness mirroring how FileBrowser wires the hook: a keydown
 * container plus roving-tabindex buttons whose refs flow through getRowRef.
 */
function Harness({
  items,
  callbacks,
  onNav,
}: {
  items: Item[];
  callbacks: RovingListNavCallbacks<Item>;
  onNav: (nav: RovingListNav<Item, HTMLButtonElement>, setItems: (i: Item[]) => void) => void;
}) {
  const [list, setList] = useState(items);
  const nav = useRovingListNav<Item, HTMLButtonElement>(list, (i) => i.name);
  onNav(nav, setList);
  return (
    <div data-testid="list" onKeyDown={nav.makeKeyDownHandler(callbacks)}>
      {list.map((item, index) => (
        <button
          key={item.name}
          ref={nav.getRowRef(index)}
          tabIndex={index === nav.activeIndex ? 0 : -1}
          data-testid={`row-${item.name}`}
        >
          {item.name}
        </button>
      ))}
    </div>
  );
}

describe("useRovingListNav", () => {
  let container: HTMLDivElement;
  let root: Root;
  let nav: RovingListNav<Item, HTMLButtonElement>;
  let setItems: (i: Item[]) => void;

  function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
    const list = container.querySelector('[data-testid="list"]') as HTMLElement;
    act(() => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
    });
  }

  function render(items: Item[], callbacks: RovingListNavCallbacks<Item>) {
    act(() => {
      root.render(
        <Harness
          items={items}
          callbacks={callbacks}
          onNav={(n, s) => {
            nav = n;
            setItems = s;
          }}
        />
      );
    });
  }

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

  it("starts with activeIndex 0", () => {
    render(ITEMS, makeCallbacks());
    expect(nav.activeIndex).toBe(0);
  });

  it("moves the active index down and up within bounds", () => {
    render(ITEMS, makeCallbacks());
    press("ArrowDown");
    expect(nav.activeIndex).toBe(1);
    press("ArrowDown");
    expect(nav.activeIndex).toBe(2);
    press("ArrowUp");
    expect(nav.activeIndex).toBe(1);
  });

  it("clamps at the top and bottom of the list", () => {
    render(ITEMS, makeCallbacks());
    press("ArrowUp");
    expect(nav.activeIndex).toBe(0);
    press("End");
    expect(nav.activeIndex).toBe(ITEMS.length - 1);
    press("ArrowDown");
    expect(nav.activeIndex).toBe(ITEMS.length - 1);
    press("Home");
    expect(nav.activeIndex).toBe(0);
  });

  it("focuses the row at the active index via getRowRef wiring", () => {
    render(ITEMS, makeCallbacks());
    press("ArrowDown");
    expect(document.activeElement).toBe(container.querySelector('[data-testid="row-apple"]'));
  });

  it("returns a stable ref callback for the same index", () => {
    render(ITEMS, makeCallbacks());
    expect(nav.getRowRef(2)).toBe(nav.getRowRef(2));
    expect(nav.getRowRef(1)).not.toBe(nav.getRowRef(2));
  });

  it("selects a single row (no anchor) when moving without shift", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("ArrowDown");
    expect(cb.onSelectSingle).toHaveBeenCalledWith(ITEMS[1], 1);
    expect(cb.onSelectRange).not.toHaveBeenCalled();
  });

  it("extends the selection from the anchor when moving with shift", () => {
    const cb = makeCallbacks({ getAnchorIndex: vi.fn(() => 0) });
    render(ITEMS, cb);
    press("ArrowDown", { shiftKey: true });
    press("ArrowDown", { shiftKey: true });
    expect(cb.onSelectRange).toHaveBeenLastCalledWith(0, 2);
    expect(cb.onSelectSingle).not.toHaveBeenCalled();
  });

  it("activates the focused item on Enter", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("ArrowDown");
    press("Enter");
    expect(cb.onActivate).toHaveBeenCalledWith(ITEMS[1], 1);
  });

  it("triggers rename on F2 for the focused item", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("F2");
    expect(cb.onRename).toHaveBeenCalledWith(ITEMS[0], 0);
  });

  it("navigates up on Backspace and Alt+ArrowLeft", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("Backspace");
    press("ArrowLeft", { altKey: true });
    expect(cb.onNavigateUp).toHaveBeenCalledTimes(2);
  });

  it("selects all on Ctrl+A and Cmd+A", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("a", { ctrlKey: true });
    press("a", { metaKey: true });
    expect(cb.onSelectAll).toHaveBeenCalledTimes(2);
  });

  it("clears the selection on Escape", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("Escape");
    expect(cb.onClearSelection).toHaveBeenCalledTimes(1);
  });

  it("type-ahead advances through successive matches of the same key", () => {
    render(ITEMS, makeCallbacks());
    // From index 0 (alpha), typing "a" advances to the next "a" match: apple.
    press("a");
    expect(nav.activeIndex).toBe(1);
  });

  it("type-ahead jumps to a label starting with a fresh key", () => {
    render(ITEMS, makeCallbacks());
    press("b");
    expect(nav.activeIndex).toBe(2);
  });

  it("resets the type-ahead buffer after the timeout window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1000);
    render(ITEMS, makeCallbacks());
    press("a"); // fresh buffer "a" → apple
    expect(nav.activeIndex).toBe(1);
    now.mockReturnValue(1000 + 800); // > 700ms later → buffer resets
    press("b"); // fresh buffer "b" → banana
    expect(nav.activeIndex).toBe(2);
    now.mockRestore();
  });

  it("accumulates multi-key type-ahead within the timeout window", () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1000);
    render(ITEMS, makeCallbacks());
    press("b"); // fresh "b" → banana (index 2)
    expect(nav.activeIndex).toBe(2);
    now.mockReturnValue(1100); // within window → buffer becomes "ba"
    press("a"); // "ba" still matches banana; must NOT reset and wrap to alpha
    expect(nav.activeIndex).toBe(2);
    now.mockRestore();
  });

  it("does not treat modifier-key combos as type-ahead", () => {
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("b", { ctrlKey: true });
    expect(nav.activeIndex).toBe(0);
  });

  it("focusRow moves the active index and DOM focus to the given row", () => {
    render(ITEMS, makeCallbacks());
    act(() => nav.focusRow(2));
    expect(nav.activeIndex).toBe(2);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="row-banana"]'));
  });

  it("focusRow lets a hierarchical consumer own arrow keys the shared handler ignores", () => {
    // ArrowLeft/ArrowRight are not handled by the shared keydown handler, so a
    // tree consumer composes its own handling and calls focusRow to move the
    // roving focus (e.g. to a parent/child row).
    const cb = makeCallbacks();
    render(ITEMS, cb);
    press("ArrowRight"); // ignored by the shared handler
    expect(nav.activeIndex).toBe(0);
    expect(cb.onSelectSingle).not.toHaveBeenCalled();
    act(() => nav.focusRow(3));
    expect(nav.activeIndex).toBe(3);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="row-cherry"]'));
  });

  it("reset() returns the active index to the top", () => {
    render(ITEMS, makeCallbacks());
    press("End");
    expect(nav.activeIndex).toBe(ITEMS.length - 1);
    act(() => nav.reset());
    expect(nav.activeIndex).toBe(0);
  });

  it("clamps the active index when the list shrinks", () => {
    render(ITEMS, makeCallbacks());
    press("End");
    expect(nav.activeIndex).toBe(3);
    act(() => setItems([{ name: "alpha" }, { name: "apple" }]));
    expect(nav.activeIndex).toBe(1);
  });

  it("ignores navigation keys on an empty list but still allows Escape", () => {
    const cb = makeCallbacks();
    render([], cb);
    press("ArrowDown");
    expect(nav.activeIndex).toBe(0);
    press("Escape");
    expect(cb.onClearSelection).toHaveBeenCalledTimes(1);
  });
});
