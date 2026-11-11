/**
 * Unit tests for the tree-row action keys (#5181): Shift+F10 / ContextMenu,
 * F2 and Delete/Backspace on a focused row, and focus rescue after a delete.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type React from "react";
import {
  captureNeighborFocus,
  handleTreeRowActionKey,
  rescueFocusAfterRemoval,
  treeRowKeyShortcuts,
} from "./treeRowKeys";

interface FakeEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget;
  currentTarget: HTMLElement;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function keyEvent(
  row: HTMLElement,
  key: string,
  mods: Partial<Pick<FakeEvent, "shiftKey" | "ctrlKey" | "metaKey" | "altKey">> = {},
  target: EventTarget = row
): FakeEvent {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
    target,
    currentTarget: row,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

const asReact = (e: FakeEvent) => e as unknown as React.KeyboardEvent<HTMLElement>;

function makeTree(count: number): { tree: HTMLElement; rows: HTMLButtonElement[] } {
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  const rows = Array.from({ length: count }, (_, i) => {
    const row = document.createElement("button");
    row.setAttribute("role", "treeitem");
    row.textContent = `row ${i}`;
    tree.appendChild(row);
    return row;
  });
  document.body.appendChild(tree);
  return { tree, rows };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("handleTreeRowActionKey", () => {
  it.each([
    ["Shift+F10", "F10", { shiftKey: true }],
    ["ContextMenu", "ContextMenu", {}],
  ])("%s synthesizes a contextmenu event on the row", (_label, key, mods) => {
    const { rows } = makeTree(1);
    const onMenu = vi.fn();
    rows[0].addEventListener("contextmenu", onMenu);
    const e = keyEvent(rows[0], key, mods);
    expect(handleTreeRowActionKey(asReact(e), {})).toBe(true);
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
  });

  it("F2 calls onRename with the row", () => {
    const { rows } = makeTree(1);
    const onRename = vi.fn();
    expect(handleTreeRowActionKey(asReact(keyEvent(rows[0], "F2")), { onRename })).toBe(true);
    expect(onRename).toHaveBeenCalledWith(rows[0]);
  });

  it.each(["Delete", "Backspace"])("%s calls onDelete with the row", (key) => {
    const { rows } = makeTree(1);
    const onDelete = vi.fn();
    expect(handleTreeRowActionKey(asReact(keyEvent(rows[0], key)), { onDelete })).toBe(true);
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
  });

  it("leaves F2 / Delete unhandled when the row has no such action", () => {
    const { rows } = makeTree(1);
    expect(handleTreeRowActionKey(asReact(keyEvent(rows[0], "F2")), {})).toBe(false);
    expect(handleTreeRowActionKey(asReact(keyEvent(rows[0], "Delete")), {})).toBe(false);
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])(
    "ignores F2 / Delete with a modifier (%o)",
    (mods) => {
      const { rows } = makeTree(1);
      const onRename = vi.fn();
      const onDelete = vi.fn();
      handleTreeRowActionKey(asReact(keyEvent(rows[0], "F2", mods)), { onRename, onDelete });
      handleTreeRowActionKey(asReact(keyEvent(rows[0], "Delete", mods)), { onRename, onDelete });
      expect(onRename).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
    }
  );

  it("ignores keys whose target is a control nested inside the row", () => {
    const { rows } = makeTree(1);
    const inner = document.createElement("span");
    rows[0].appendChild(inner);
    const onDelete = vi.fn();
    const e = keyEvent(rows[0], "Delete", {}, inner);
    expect(handleTreeRowActionKey(asReact(e), { onDelete })).toBe(false);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("ignores Shift+F10 with another modifier", () => {
    const { rows } = makeTree(1);
    const onMenu = vi.fn();
    rows[0].addEventListener("contextmenu", onMenu);
    const e = keyEvent(rows[0], "F10", { shiftKey: true, ctrlKey: true });
    expect(handleTreeRowActionKey(asReact(e), {})).toBe(false);
    expect(onMenu).not.toHaveBeenCalled();
  });
});

describe("treeRowKeyShortcuts", () => {
  it("lists the keys a row offers", () => {
    expect(treeRowKeyShortcuts({})).toBe("Shift+F10");
    expect(treeRowKeyShortcuts({ delete: true })).toBe("Shift+F10 Delete");
    expect(treeRowKeyShortcuts({ rename: true, delete: true })).toBe("Shift+F10 F2 Delete");
  });
});

describe("captureNeighborFocus", () => {
  it("resolves to the row itself while it is still rendered", () => {
    const { rows } = makeTree(3);
    expect(captureNeighborFocus(rows[1])()).toBe(rows[1]);
  });

  it("resolves to the row now at the removed row's position", () => {
    const { rows } = makeTree(3);
    const target = captureNeighborFocus(rows[1]);
    rows[1].remove();
    expect(target()).toBe(rows[2]);
  });

  it("falls back to the new last row when the last row was removed", () => {
    const { rows } = makeTree(3);
    const target = captureNeighborFocus(rows[2]);
    rows[2].remove();
    expect(target()).toBe(rows[1]);
  });

  it("resolves to null when no row is left", () => {
    const { rows } = makeTree(1);
    const target = captureNeighborFocus(rows[0]);
    rows[0].remove();
    expect(target()).toBeNull();
  });
});

describe("rescueFocusAfterRemoval", () => {
  /** Drop focus to <body>, as removing the focused element or a dialog does. */
  function strand() {
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
  }

  it("focuses the next row once the deleted row is gone", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    rows[0].focus();
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    rows[0].remove();
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(rows[1]);
  });

  it("ends once focus has landed, so a later stranding is left alone", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(3);
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    rows[0].remove();
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(rows[1]);
    // An undo restoring the row, or any later re-render, must not be chased.
    rows[1].remove();
    strand();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(document.body);
  });

  it("puts focus back on the row while it is still rendered", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(rows[0]);
  });

  it("never pulls focus back from an element that claimed it", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    const other = document.createElement("input");
    document.body.appendChild(other);
    const target = captureNeighborFocus(rows[0]);
    rescueFocusAfterRemoval(target);
    rows[0].remove();
    other.focus();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(other);
  });

  it("ends when focus moves elsewhere, even if focus is stranded later", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    const other = document.createElement("input");
    document.body.appendChild(other);
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    other.focus();
    strand();
    rows[0].remove();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(document.body);
  });

  it("a failed delete (row still there once settled) does not move focus later", async () => {
    vi.useFakeTimers();
    const { rows } = makeTree(3);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]), { settled: Promise.resolve() });
    await vi.advanceTimersByTimeAsync(500);
    // The row is removed long after the delete failed (an unrelated refresh).
    rows[0].remove();
    strand();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(document.body);
  });

  it("a delete that settles before the DOM catches up still moves focus", async () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]), { settled: Promise.resolve() });
    await vi.advanceTimersByTimeAsync(30);
    rows[0].remove();
    vi.advanceTimersByTime(50);
    expect(document.activeElement).toBe(rows[1]);
  });

  it("cancel() — an undo — stops it before the row goes", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    const rescue = rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    rescue.cancel();
    rows[0].remove();
    strand();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(document.body);
  });

  it("clicking an Undo button ends it", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(3);
    const undo = document.createElement("button");
    document.body.appendChild(undo);
    rows[0].focus();
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    undo.focus();
    rows[0].remove();
    strand();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not outlive its tree", () => {
    vi.useFakeTimers();
    const { tree, rows } = makeTree(2);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]));
    tree.remove();
    // A new tree with matching rows appears; the old rescue must not touch it.
    const next = makeTree(2);
    strand();
    vi.advanceTimersByTime(3000);
    expect(document.activeElement).toBe(document.body);
    expect(next.rows.some((r) => r === document.activeElement)).toBe(false);
  });

  it("is replaced by a newer rescue", () => {
    vi.useFakeTimers();
    const a = makeTree(2);
    const b = makeTree(2);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    rescueFocusAfterRemoval(captureNeighborFocus(a.rows[0]));
    rescueFocusAfterRemoval(captureNeighborFocus(b.rows[0]));
    a.rows[0].remove();
    b.rows[0].remove();
    strand();
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(b.rows[1]);
  });

  it("does nothing for a row outside any tree", () => {
    vi.useFakeTimers();
    const row = document.createElement("button");
    document.body.appendChild(row);
    rescueFocusAfterRemoval(captureNeighborFocus(row));
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(document.body);
  });

  it("gives up after its window", () => {
    vi.useFakeTimers();
    const { rows } = makeTree(2);
    const other = document.createElement("input");
    document.body.appendChild(other);
    other.focus();
    rescueFocusAfterRemoval(captureNeighborFocus(rows[0]), { windowMs: 500 });
    vi.advanceTimersByTime(600);
    other.blur();
    rows[0].remove();
    vi.advanceTimersByTime(600);
    expect(document.activeElement).toBe(document.body);
  });
});
