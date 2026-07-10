import { describe, it, expect } from "vitest";
import { filterConnectionTree, connectionMatchesQuery } from "./connectionSearch";
import type { SavedConnection, ConnectionFolder } from "@/types/connection";

function conn(
  id: string,
  name: string,
  opts: { folderId?: string | null; host?: string } = {}
): SavedConnection {
  return {
    id,
    name,
    folderId: opts.folderId ?? null,
    config: {
      type: opts.host ? "ssh" : "local",
      config: opts.host ? { host: opts.host } : {},
    } as SavedConnection["config"],
  };
}

function folder(id: string, name: string, parentId: string | null = null): ConnectionFolder {
  return { id, name, parentId, isExpanded: false };
}

describe("connectionMatchesQuery", () => {
  it("matches by name (case-insensitive)", () => {
    expect(connectionMatchesQuery(conn("c1", "Production DB"), "prod")).toBe(true);
    expect(connectionMatchesQuery(conn("c1", "Production DB"), "xyz")).toBe(false);
  });

  it("matches by host", () => {
    expect(connectionMatchesQuery(conn("c1", "Box", { host: "10.0.0.5" }), "10.0.0")).toBe(true);
  });

  it("empty query matches everything", () => {
    expect(connectionMatchesQuery(conn("c1", "Anything"), "")).toBe(true);
  });
});

describe("filterConnectionTree", () => {
  it("returns null for an empty query", () => {
    expect(filterConnectionTree("   ", [], [conn("c1", "A")])).toBeNull();
  });

  it("keeps only matching connections", () => {
    const filter = filterConnectionTree("web", [], [conn("c1", "web-1"), conn("c2", "db-1")]);
    expect(filter?.matchingConnectionIds.has("c1")).toBe(true);
    expect(filter?.matchingConnectionIds.has("c2")).toBe(false);
  });

  it("marks ancestor folders of matches as visible", () => {
    const folders = [folder("f1", "Servers"), folder("f2", "Prod", "f1")];
    const conns = [conn("c1", "web-1", { folderId: "f2" }), conn("c2", "db-1", { folderId: null })];
    const filter = filterConnectionTree("web", folders, conns);
    expect(filter?.visibleFolderIds.has("f1")).toBe(true);
    expect(filter?.visibleFolderIds.has("f2")).toBe(true);
  });

  it("hides folders with no matching descendants", () => {
    const folders = [folder("f1", "Servers"), folder("f2", "Empty")];
    const conns = [conn("c1", "web-1", { folderId: "f1" })];
    const filter = filterConnectionTree("web", folders, conns);
    expect(filter?.visibleFolderIds.has("f1")).toBe(true);
    expect(filter?.visibleFolderIds.has("f2")).toBe(false);
  });

  it("matches nothing for a non-matching query", () => {
    const filter = filterConnectionTree("zzz", [], [conn("c1", "web")]);
    expect(filter?.matchingConnectionIds.size).toBe(0);
    expect(filter?.visibleFolderIds.size).toBe(0);
  });
});
