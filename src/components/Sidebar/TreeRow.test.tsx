/**
 * Unit tests for the shared sidebar tree-row primitives (UISF-017).
 *
 * These lock in the DOM parity contract the extraction relies on: for a given
 * set of props the rows must render the exact classes, ARIA, indentation, and
 * test hooks the previous inline markup in `ConnectionList` / `AgentNode`
 * produced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TreeFolderRow, TreeItemRow, treeRowPaddingLeft } from "./TreeRow";

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
});

function treeitem(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>('[role="treeitem"]');
  if (!el) throw new Error("no treeitem rendered");
  return el;
}

describe("treeRowPaddingLeft", () => {
  it("matches the shared depth * 16 + 8 indent formula", () => {
    expect(treeRowPaddingLeft(0)).toBe(8);
    expect(treeRowPaddingLeft(1)).toBe(24);
    expect(treeRowPaddingLeft(2)).toBe(40);
  });
});

describe("TreeFolderRow", () => {
  it("renders the shared folder shell with tree ARIA, indent, and label", () => {
    act(() =>
      root.render(
        <TreeFolderRow
          buttonRef={() => {}}
          label="Servers"
          expanded={false}
          indentPx={treeRowPaddingLeft(1)}
          ariaLevel={2}
          tabIndex={-1}
          testId="folder-toggle-f1"
        />
      )
    );
    const btn = treeitem();
    expect(btn.classList.contains("connection-tree__folder")).toBe(true);
    expect(btn.classList.contains("connection-tree__folder--drop-over")).toBe(false);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-level")).toBe("2");
    expect(btn.tabIndex).toBe(-1);
    expect(btn.style.paddingLeft).toBe("24px");
    expect(btn.getAttribute("data-testid")).toBe("folder-toggle-f1");
    expect(btn.querySelector(".connection-tree__label")?.textContent).toBe("Servers");
    expect(btn.querySelector(".connection-tree__chevron")).not.toBeNull();
  });

  it("applies the drop-over modifier and omits data-testid when not provided", () => {
    act(() =>
      root.render(
        <TreeFolderRow
          buttonRef={() => {}}
          label="Servers"
          expanded
          indentPx={8}
          ariaLevel={1}
          tabIndex={0}
          dropOver
        />
      )
    );
    const btn = treeitem();
    expect(btn.classList.contains("connection-tree__folder--drop-over")).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.tabIndex).toBe(0);
    expect(btn.hasAttribute("data-testid")).toBe(false);
  });

  it("wires up the click handler", () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <TreeFolderRow
          buttonRef={() => {}}
          label="F"
          expanded={false}
          indentPx={8}
          ariaLevel={1}
          tabIndex={0}
          onClick={onClick}
        />
      )
    );
    act(() => treeitem().click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("TreeItemRow", () => {
  it("renders the base item shell with tree ARIA, indent, and children", () => {
    act(() =>
      root.render(
        <TreeItemRow
          buttonRef={() => {}}
          indentPx={treeRowPaddingLeft(1)}
          ariaLevel={2}
          tabIndex={-1}
          ariaSelected={false}
          testId="connection-item-c1"
        >
          <span className="connection-tree__label">host</span>
        </TreeItemRow>
      )
    );
    const btn = treeitem();
    expect(btn.className).toBe("connection-tree__item");
    expect(btn.getAttribute("aria-level")).toBe("2");
    expect(btn.getAttribute("aria-selected")).toBe("false");
    expect(btn.tabIndex).toBe(-1);
    expect(btn.style.paddingLeft).toBe("24px");
    expect(btn.getAttribute("data-testid")).toBe("connection-item-c1");
    expect(btn.querySelector(".connection-tree__label")?.textContent).toBe("host");
  });

  it("assembles modifier classes in order: dragging, selected, persistent, reorder-over", () => {
    act(() =>
      root.render(
        <TreeItemRow
          buttonRef={() => {}}
          indentPx={8}
          ariaLevel={1}
          tabIndex={0}
          dragging
          selected
          persistent
          reorderOver
        >
          x
        </TreeItemRow>
      )
    );
    expect(treeitem().className).toBe(
      "connection-tree__item connection-tree__item--dragging connection-tree__item--selected connection-tree__item--persistent connection-tree__item--reorder-over"
    );
  });

  it("maps individual modifier flags to the right classes", () => {
    act(() =>
      root.render(
        <TreeItemRow buttonRef={() => {}} indentPx={8} ariaLevel={1} tabIndex={0} selected>
          x
        </TreeItemRow>
      )
    );
    const btn = treeitem();
    expect(btn.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(btn.classList.contains("connection-tree__item--dragging")).toBe(false);
    expect(btn.classList.contains("connection-tree__item--reorder-over")).toBe(false);
  });

  it("omits aria-selected and data-testid when not provided (e.g. session rows)", () => {
    act(() =>
      root.render(
        <TreeItemRow buttonRef={() => {}} indentPx={32} ariaLevel={1} tabIndex={-1}>
          x
        </TreeItemRow>
      )
    );
    const btn = treeitem();
    expect(btn.hasAttribute("aria-selected")).toBe(false);
    expect(btn.hasAttribute("data-testid")).toBe(false);
    expect(btn.style.paddingLeft).toBe("32px");
  });

  it("forwards a ref to the button and composes it with buttonRef (Radix asChild)", () => {
    const forwarded = { current: null as HTMLButtonElement | null };
    const viaButtonRef: HTMLButtonElement[] = [];
    act(() =>
      root.render(
        <TreeItemRow
          ref={forwarded}
          buttonRef={(el) => {
            if (el) viaButtonRef.push(el);
          }}
          indentPx={8}
          ariaLevel={1}
          tabIndex={0}
        >
          x
        </TreeItemRow>
      )
    );
    const btn = treeitem();
    expect(forwarded.current).toBe(btn);
    expect(viaButtonRef[0]).toBe(btn);
  });

  it("forwards injected props (e.g. onContextMenu, data-state) to the button", () => {
    const onContextMenu = vi.fn();
    act(() =>
      root.render(
        <TreeItemRow
          buttonRef={() => {}}
          indentPx={8}
          ariaLevel={1}
          tabIndex={0}
          onContextMenu={onContextMenu}
          data-state="open"
        >
          x
        </TreeItemRow>
      )
    );
    const btn = treeitem();
    expect(btn.getAttribute("data-state")).toBe("open");
    act(() => btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("composes an injected onPointerDown (Radix) with dnd-kit's onPointerDown", () => {
    const radixPointerDown = vi.fn();
    const dndPointerDown = vi.fn();
    act(() =>
      root.render(
        <TreeItemRow
          buttonRef={() => {}}
          indentPx={8}
          ariaLevel={1}
          tabIndex={0}
          onPointerDown={radixPointerDown}
          dragListeners={{ onPointerDown: dndPointerDown }}
        >
          x
        </TreeItemRow>
      )
    );
    act(() => {
      // jsdom lacks PointerEvent; React's onPointerDown fires from a pointerdown MouseEvent.
      treeitem().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(radixPointerDown).toHaveBeenCalledTimes(1);
    expect(dndPointerDown).toHaveBeenCalledTimes(1);
  });

  it("spreads drag attributes/listeners while explicit tree ARIA wins over them", () => {
    act(() =>
      root.render(
        <TreeItemRow
          buttonRef={() => {}}
          indentPx={8}
          ariaLevel={3}
          tabIndex={0}
          ariaSelected
          dragAttributes={{
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "draggable",
            "aria-describedby": "dnd-1",
          }}
          dragListeners={{ onPointerDown: vi.fn() }}
        >
          x
        </TreeItemRow>
      )
    );
    // The explicit role="treeitem" / aria-level must override dnd's role="button".
    const btn = treeitem();
    expect(btn.getAttribute("role")).toBe("treeitem");
    expect(btn.getAttribute("aria-level")).toBe("3");
    expect(btn.getAttribute("aria-roledescription")).toBe("draggable");
    expect(btn.getAttribute("aria-describedby")).toBe("dnd-1");
  });
});
