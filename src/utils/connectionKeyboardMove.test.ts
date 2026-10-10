import { describe, it, expect } from "vitest";
import {
  agentReorderIndices,
  connectionReorderIndices,
  folderMoveTargets,
  moveShortcutDelta,
} from "./connectionKeyboardMove";
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

describe("agentReorderIndices (#4641)", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("swaps with the neighbour above or below", () => {
    expect(agentReorderIndices("a", 1, agents, agents)).toEqual({ oldIndex: 0, newIndex: 1 });
    expect(agentReorderIndices("c", -1, agents, agents)).toEqual({ oldIndex: 2, newIndex: 1 });
  });

  it("returns null for the first agent moving up and the last moving down", () => {
    expect(agentReorderIndices("a", -1, agents, agents)).toBeNull();
    expect(agentReorderIndices("c", 1, agents, agents)).toBeNull();
  });

  it("returns null for a single agent or an unknown one", () => {
    expect(agentReorderIndices("a", 1, [{ id: "a" }], [{ id: "a" }])).toBeNull();
    expect(agentReorderIndices("zz", 1, agents, agents)).toBeNull();
  });

  it("swaps with the visible neighbour when a filter hides agents", () => {
    const visible = [{ id: "a" }, { id: "c" }];
    expect(agentReorderIndices("c", -1, visible, agents)).toEqual({ oldIndex: 2, newIndex: 0 });
  });
});

describe("moveShortcutDelta (#4641)", () => {
  const key = (
    k: string,
    mods: Partial<Record<"ctrlKey" | "metaKey" | "shiftKey" | "altKey", boolean>>
  ) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  it("reads Ctrl or Cmd with Shift and an up/down arrow", () => {
    expect(moveShortcutDelta(key("ArrowUp", { ctrlKey: true, shiftKey: true }))).toBe(-1);
    expect(moveShortcutDelta(key("ArrowDown", { metaKey: true, shiftKey: true }))).toBe(1);
  });

  it("ignores other keys and modifier combinations", () => {
    expect(moveShortcutDelta(key("ArrowDown", {}))).toBeNull();
    expect(moveShortcutDelta(key("ArrowDown", { shiftKey: true }))).toBeNull();
    expect(moveShortcutDelta(key("ArrowDown", { ctrlKey: true }))).toBeNull();
    expect(
      moveShortcutDelta(key("ArrowDown", { ctrlKey: true, shiftKey: true, altKey: true }))
    ).toBeNull();
    expect(moveShortcutDelta(key("ArrowLeft", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });
});
