import { describe, it, expect } from "vitest";
import { connectionReorderIndices, folderMoveTargets } from "./connectionKeyboardMove";
import type { ConnectionFolder, SavedConnection } from "@/types/connection";

function conn(id: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name: id,
    folderId,
    config: { type: "local", config: {} } as SavedConnection["config"],
  };
}

function folder(id: string, name: string, parentId: string | null = null): ConnectionFolder {
  return { id, name, parentId, isExpanded: true };
}

describe("folderMoveTargets (#4528)", () => {
  it("lists folders depth first with their full path", () => {
    const folders = [
      folder("b", "Beta"),
      folder("a", "Alpha"),
      folder("a1", "One", "a"),
      folder("a1x", "Deep", "a1"),
    ];
    expect(folderMoveTargets(folders)).toEqual([
      { id: "b", label: "Beta" },
      { id: "a", label: "Alpha" },
      { id: "a1", label: "Alpha / One" },
      { id: "a1x", label: "Alpha / One / Deep" },
    ]);
  });

  it("returns nothing without folders", () => {
    expect(folderMoveTargets([])).toEqual([]);
  });

  it("drops folders whose parent is missing", () => {
    expect(folderMoveTargets([folder("orphan", "Orphan", "gone")])).toEqual([]);
  });
});

describe("connectionReorderIndices (#4528)", () => {
  const all = [conn("r1"), conn("f1", "f"), conn("r2"), conn("f2", "f")];

  it("swaps with the next sibling in the same folder, using full-list indices", () => {
    expect(connectionReorderIndices("f1", 1, all, all)).toEqual({ oldIndex: 1, newIndex: 3 });
    expect(connectionReorderIndices("r2", -1, all, all)).toEqual({ oldIndex: 2, newIndex: 0 });
  });

  it("returns null at the folder's first or last position", () => {
    expect(connectionReorderIndices("f1", -1, all, all)).toBeNull();
    expect(connectionReorderIndices("f2", 1, all, all)).toBeNull();
    expect(connectionReorderIndices("r1", -1, all, all)).toBeNull();
  });

  it("returns null for an unknown connection", () => {
    expect(connectionReorderIndices("nope", 1, all, all)).toBeNull();
  });

  it("skips siblings hidden from the tree but indexes into the full list", () => {
    const hidden = conn("hidden");
    const full = [conn("r1"), hidden, conn("r2")];
    const shown = full.filter((c) => c !== hidden);
    expect(connectionReorderIndices("r2", -1, shown, full)).toEqual({ oldIndex: 2, newIndex: 0 });
  });
});
