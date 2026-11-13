/**
 * TransferPane's reset effect (#4370): a new directory clears the selection,
 * and an unrelated re-render (new entries, a new selection) does not. Plus its
 * path bar (#5541): the sidebar's folding breadcrumbs with an edit mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { DndContext } from "@dnd-kit/core";
import type { FileEntry } from "@/types/connection";

vi.mock("@/components/Sidebar/FileBookmarksMenu", () => ({ FileBookmarksMenu: () => null }));

import { TooltipProvider } from "@/components/ui";
import { TransferPane } from "./TransferPane";
import type { PaneListing } from "./usePaneListing";

function entry(name: string): FileEntry {
  return {
    name,
    path: `/home/${name}`,
    isDirectory: false,
    size: 1,
    modified: "",
    permissions: null,
  } as FileEntry;
}

function listing(path: string, entries: FileEntry[] = [entry("a"), entry("b")]): PaneListing {
  return {
    path,
    entries,
    loading: false,
    error: null,
    navigate: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
    up: vi.fn(() => Promise.resolve()),
  };
}

let container: HTMLDivElement;
let root: Root;

function render(
  paneListing: PaneListing,
  onSelectedChange: (next: Set<string>) => void,
  selected: ReadonlySet<string> = new Set(),
  placeholder?: string
) {
  act(() => {
    root.render(
      <TooltipProvider>
        <DndContext>
          <TransferPane
            side="local"
            title="Local"
            listing={paneListing}
            selected={selected}
            onSelectedChange={onSelectedChange}
            onCopy={vi.fn()}
            canCopy
            bookmarkScope={null}
            placeholder={placeholder}
          />
        </DndContext>
      </TooltipProvider>
    );
  });
}

describe("TransferPane reset effect (#4370)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("clears the selection when the directory changes", () => {
    const onSelectedChange = vi.fn();
    render(listing("/home"), onSelectedChange);
    onSelectedChange.mockClear();

    render(listing("/home/sub"), onSelectedChange, new Set(["/home/a"]));

    expect(onSelectedChange).toHaveBeenCalledTimes(1);
    expect(onSelectedChange).toHaveBeenCalledWith(new Set());
  });

  it("keeps the selection across a re-render in the same directory", () => {
    const onSelectedChange = vi.fn();
    render(listing("/home"), onSelectedChange);
    onSelectedChange.mockClear();

    render(
      listing("/home", [entry("a"), entry("b"), entry("c")]),
      onSelectedChange,
      new Set(["/home/a"])
    );
    render(listing("/home"), onSelectedChange, new Set(["/home/a", "/home/b"]));

    expect(onSelectedChange).not.toHaveBeenCalled();
  });

  it("syncs the path bar to the new directory", () => {
    const onSelectedChange = vi.fn();
    render(listing("/home"), onSelectedChange);
    render(listing("/var/log"), onSelectedChange);

    expect(q("transfer-pane-local-current-path")?.getAttribute("title")).toBe("/var/log");
  });
});

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function keyDown(el: Element, init: KeyboardEventInit) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

describe("TransferPane path bar (#5541)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the path as breadcrumbs with the full path as the tooltip", () => {
    render(listing("/srv/app/releases"), vi.fn());
    const nav = q("transfer-pane-local-current-path");
    expect(nav?.getAttribute("title")).toBe("/srv/app/releases");
    expect(nav?.getAttribute("aria-label")).toBe("Local path");
    const crumbs = Array.from(nav!.querySelectorAll("button")).map((b) => b.dataset.testid);
    expect(crumbs).toEqual([
      "transfer-pane-local-crumb-/",
      "transfer-pane-local-crumb-srv",
      "transfer-pane-local-crumb-app",
      "transfer-pane-local-crumb-releases",
    ]);
    // No plain text field until the user asks to edit.
    expect(container.querySelector("input")).toBeNull();
  });

  it("navigates the pane when an ancestor segment is clicked", () => {
    const paneListing = listing("/srv/app/releases");
    render(paneListing, vi.fn());
    act(() => q("transfer-pane-local-crumb-app")?.click());
    expect(paneListing.navigate).toHaveBeenCalledWith("/srv/app");
  });

  it("edits the full path from the current folder and navigates on Enter", () => {
    const paneListing = listing("/srv/app");
    render(paneListing, vi.fn());
    act(() => q("transfer-pane-local-crumb-app")?.click());
    const input = q("transfer-pane-local-path-input") as HTMLInputElement;
    expect(input.value).toBe("/srv/app");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "/var/log");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    keyDown(input, { key: "Enter" });
    expect(paneListing.navigate).toHaveBeenCalledWith("/var/log");
    expect(q("transfer-pane-local-path-input")).toBeNull();
  });

  it("opens the path editor on Ctrl+L from the focused list (Windows/Linux)", () => {
    render(listing("/srv/app"), vi.fn());
    keyDown(q("transfer-pane-local-list")!, { key: "l", code: "KeyL", ctrlKey: true });
    expect((q("transfer-pane-local-path-input") as HTMLInputElement).value).toBe("/srv/app");
  });

  it("offers no editor while the pane has nothing to list", () => {
    render(listing(""), vi.fn(), new Set(), "Pick a remote session");
    expect(q("transfer-pane-local-path-edit")).toBeNull();
    keyDown(q("transfer-pane-local")!, { key: "l", code: "KeyL", ctrlKey: true });
    expect(q("transfer-pane-local-path-input")).toBeNull();
  });
});
