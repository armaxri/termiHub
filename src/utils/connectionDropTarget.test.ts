import { describe, it, expect } from "vitest";
import type { SavedConnection } from "@/types/connection";
import { resolveConnectionDrop, type ConnectionDropContext } from "./connectionDropTarget";

function conn(id: string, folderId: string | null): SavedConnection {
  return {
    id,
    name: id,
    folderId,
    config: { type: "local", config: {} },
  } as unknown as SavedConnection;
}

const rootA = conn("a", null);
const rootB = conn("b", null);
const inFolder1 = conn("c", "f1");
const inFolder1b = conn("d", "f1");
const inFolder2 = conn("e", "f2");
const all = [rootA, rootB, inFolder1, inFolder1b, inFolder2];

function ctx(overrides: Partial<ConnectionDropContext>): ConnectionDropContext {
  return {
    dragged: rootA,
    over: { id: "root" },
    selectedIds: new Set(),
    connections: all,
    allConnections: all,
    ...overrides,
  };
}

describe("resolveConnectionDrop", () => {
  describe("root drop (MT-CONN-32)", () => {
    it("moves a foldered connection out to the root", () => {
      expect(resolveConnectionDrop(ctx({ dragged: inFolder1, over: { id: "root" } }))).toEqual({
        kind: "move",
        connectionIds: ["c"],
        targetFolderId: null,
      });
    });

    it("yields an empty move for a connection already at the root", () => {
      expect(resolveConnectionDrop(ctx({ dragged: rootA, over: { id: "root" } }))).toEqual({
        kind: "move",
        connectionIds: [],
        targetFolderId: null,
      });
    });

    it("treats id 'root' as root regardless of the reported type", () => {
      const action = resolveConnectionDrop(
        ctx({ dragged: inFolder2, over: { id: "root", type: "folder" } })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["e"], targetFolderId: null });
    });
  });

  describe("folder drop (MT-CONN-24)", () => {
    it("moves a root connection into the folder", () => {
      expect(
        resolveConnectionDrop(ctx({ dragged: rootA, over: { id: "f1", type: "folder" } }))
      ).toEqual({ kind: "move", connectionIds: ["a"], targetFolderId: "f1" });
    });

    it("moves an external-file connection into a local folder", () => {
      const external = { ...conn("ext", null), sourceFile: "/tmp/shared.json" };
      const action = resolveConnectionDrop(
        ctx({
          dragged: external,
          over: { id: "f1", type: "folder" },
          connections: [...all, external],
          allConnections: [...all, external],
        })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["ext"], targetFolderId: "f1" });
    });

    it("moves the whole multi-selection, skipping members already in the folder", () => {
      const action = resolveConnectionDrop(
        ctx({
          dragged: rootA,
          over: { id: "f1", type: "folder" },
          selectedIds: new Set(["a", "b", "c"]),
        })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["a", "b"], targetFolderId: "f1" });
    });

    it("moves only the dragged item when it is not part of the selection", () => {
      const action = resolveConnectionDrop(
        ctx({
          dragged: inFolder2,
          over: { id: "f1", type: "folder" },
          selectedIds: new Set(["a", "b"]),
        })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["e"], targetFolderId: "f1" });
    });
  });

  describe("drop onto a connection", () => {
    it("reorders siblings in the same folder using full-list indices", () => {
      const action = resolveConnectionDrop(
        ctx({ dragged: rootB, over: { id: "a", type: "connection", connection: rootA } })
      );
      expect(action).toEqual({ kind: "reorder", oldIndex: 1, newIndex: 0 });
    });

    it("uses allConnections (not the filtered list) for reorder indices", () => {
      const action = resolveConnectionDrop(
        ctx({
          dragged: inFolder1b,
          over: { id: "c", type: "connection", connection: inFolder1 },
          connections: [inFolder1, inFolder1b],
        })
      );
      expect(action).toEqual({ kind: "reorder", oldIndex: 3, newIndex: 2 });
    });

    it("clears when a sibling is missing from the full list", () => {
      const action = resolveConnectionDrop(
        ctx({
          dragged: rootB,
          over: { id: "a", type: "connection", connection: rootA },
          allConnections: [rootB],
        })
      );
      expect(action).toEqual({ kind: "clear" });
    });

    it("clears when dropped onto itself", () => {
      const action = resolveConnectionDrop(
        ctx({ dragged: rootA, over: { id: "a", type: "connection", connection: rootA } })
      );
      expect(action).toEqual({ kind: "clear" });
    });

    it("moves into the target's folder across folders", () => {
      const action = resolveConnectionDrop(
        ctx({ dragged: rootA, over: { id: "e", type: "connection", connection: inFolder2 } })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["a"], targetFolderId: "f2" });
    });

    it("moves out to root when dropped onto a root connection from a folder", () => {
      const action = resolveConnectionDrop(
        ctx({ dragged: inFolder1, over: { id: "a", type: "connection", connection: rootA } })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["c"], targetFolderId: null });
    });

    it("a multi-select drag onto a same-folder sibling moves instead of reordering", () => {
      const action = resolveConnectionDrop(
        ctx({
          dragged: rootA,
          over: { id: "b", type: "connection", connection: rootB },
          selectedIds: new Set(["a", "e"]),
        })
      );
      expect(action).toEqual({ kind: "move", connectionIds: ["e"], targetFolderId: null });
    });
  });

  it("ignores drops on unrelated targets", () => {
    expect(resolveConnectionDrop(ctx({ over: { id: "agent-root:x", type: "agent" } }))).toEqual({
      kind: "ignore",
    });
    expect(resolveConnectionDrop(ctx({ over: { id: "something" } }))).toEqual({ kind: "ignore" });
  });
});
