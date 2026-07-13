import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useFlatRovingNav, FlatRovingNav } from "./useFlatRovingNav";

interface Item {
  name: string;
}

const ITEMS: Item[] = [
  { name: "alpha" },
  { name: "apple" },
  { name: "banana" },
  { name: "cherry" },
];

/**
 * Minimal list harness mirroring how a flat sidebar wires the hook: a keydown
 * container plus roving-tabindex rows whose props flow through getItemProps.
 */
function Harness({ items, onActivate }: { items: Item[]; onActivate: (item: Item) => void }) {
  const nav = useFlatRovingNav<Item, HTMLButtonElement>(items, (i) => i.name, onActivate);
  navRef = nav;
  return (
    <div data-testid="list" role="tree" onKeyDown={nav.onKeyDown}>
      {items.map((item, index) => {
        const { ref, ...props } = nav.getItemProps(index);
        return (
          <button
            key={item.name}
            ref={ref}
            role="treeitem"
            aria-level={1}
            data-testid={`row-${item.name}`}
            {...props}
          >
            {item.name}
          </button>
        );
      })}
    </div>
  );
}

let navRef: FlatRovingNav<HTMLButtonElement>;

describe("useFlatRovingNav", () => {
  let container: HTMLDivElement;
  let root: Root;

  function press(key: string, opts: Partial<KeyboardEventInit> = {}) {
    const list = container.querySelector('[data-testid="list"]') as HTMLElement;
    act(() => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts }));
    });
  }

  function render(items: Item[], onActivate: (item: Item) => void) {
    act(() => {
      root.render(<Harness items={items} onActivate={onActivate} />);
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

  it("starts with the first row active (tabIndex 0)", () => {
    render(ITEMS, vi.fn());
    expect(navRef.activeIndex).toBe(0);
    expect(navRef.getItemProps(0).tabIndex).toBe(0);
    expect(navRef.getItemProps(1).tabIndex).toBe(-1);
  });

  it("moves the active row with ArrowDown/ArrowUp and focuses it", () => {
    render(ITEMS, vi.fn());
    press("ArrowDown");
    expect(navRef.activeIndex).toBe(1);
    expect(document.activeElement).toBe(container.querySelector('[data-testid="row-apple"]'));
    press("ArrowUp");
    expect(navRef.activeIndex).toBe(0);
  });

  it("jumps to the ends with Home/End", () => {
    render(ITEMS, vi.fn());
    press("End");
    expect(navRef.activeIndex).toBe(ITEMS.length - 1);
    press("Home");
    expect(navRef.activeIndex).toBe(0);
  });

  it("activates the focused row on Enter", () => {
    const onActivate = vi.fn();
    render(ITEMS, onActivate);
    press("ArrowDown");
    press("Enter");
    expect(onActivate).toHaveBeenCalledWith(ITEMS[1], 1);
  });

  it("type-ahead jumps to a label starting with the typed key", () => {
    render(ITEMS, vi.fn());
    press("b");
    expect(navRef.activeIndex).toBe(2);
  });

  it("onFocus syncs the active index to the focused row", () => {
    render(ITEMS, vi.fn());
    act(() => navRef.getItemProps(2).onFocus());
    expect(navRef.activeIndex).toBe(2);
  });
});
