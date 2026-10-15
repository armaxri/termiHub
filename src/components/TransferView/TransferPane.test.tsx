/**
 * TransferPane's reset effect (#4370): a new directory clears the selection,
 * and an unrelated re-render (new entries, a new selection) does not.
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
  selected: ReadonlySet<string> = new Set()
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

  it("syncs the path field to the new directory", () => {
    const onSelectedChange = vi.fn();
    render(listing("/home"), onSelectedChange);
    render(listing("/var/log"), onSelectedChange);

    const input = container.querySelector<HTMLInputElement>("input");
    expect(input?.value).toBe("/var/log");
  });
});
