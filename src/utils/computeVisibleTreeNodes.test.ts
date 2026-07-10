import { describe, it, expect } from "vitest";
import { computeVisibleTreeNodes } from "./computeVisibleTreeNodes";
import { filterConnectionTree } from "./connectionSearch";
import type { SavedConnection, ConnectionFolder } from "@/types/connection";

function conn(id: string, name: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name,
    folderId,
    config: { type: "local", config: {} } as SavedConnection["config"],
  };
}

function folder(id: string, parentId: string | null = null, isExpanded = true): ConnectionFolder {
  return { id, name: id, parentId, isExpanded };
}

describe("computeVisibleTreeNodes (no filter)", () => {
  it("flattens expanded folders before sibling connections in visual order", () => {
    const folders = [folder("f1")];
    const conns = [conn("c-nested", "n", "f1"), conn("c-root", "r", null)];
    const nodes = computeVisibleTreeNodes(folders, conns, null);
    expect(nodes.map((n) => n.id)).toEqual(["f1", "c-nested", "c-root"]);
    expect(nodes[0].kind).toBe("folder");
    expect(nodes[0].isExpanded).toBe(true);
    expect(nodes[0].hasChildren).toBe(true);
  });

  it("omits children of a collapsed folder", () => {
    const folders = [folder("f1", null, false)];
    const conns = [conn("c-nested", "n", "f1")];
    const nodes = computeVisibleTreeNodes(folders, conns, null);
    expect(nodes.map((n) => n.id)).toEqual(["f1"]);
    expect(nodes[0].isExpanded).toBe(false);
  });

  it("records parentId for ArrowLeft navigation", () => {
    const nodes = computeVisibleTreeNodes([folder("f1")], [conn("c1", "c", "f1")], null);
    const child = nodes.find((n) => n.id === "c1");
    expect(child?.parentId).toBe("f1");
    expect(child?.depth).toBe(1);
  });
});

describe("computeVisibleTreeNodes (filtered)", () => {
  it("includes only matches and their ancestors, always expanded", () => {
    const folders = [folder("f1", null, false), folder("f2", null, true)];
    const conns = [conn("c1", "web", "f1"), conn("c2", "db", "f2")];
    const filter = filterConnectionTree("web", folders, conns);
    const nodes = computeVisibleTreeNodes(folders, conns, filter);
    // f1 collapsed in storage, but a match inside forces it visible + expanded.
    expect(nodes.map((n) => n.id)).toEqual(["f1", "c1"]);
    expect(nodes[0].isExpanded).toBe(true);
  });
});
