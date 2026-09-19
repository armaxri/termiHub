import { describe, it, expect } from "vitest";
import {
  filterAgentTree,
  agentDefinitionMatchesQuery,
  agentNameMatchesQuery,
} from "./agentTreeSearch";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";

function def(id: string, name: string, folderId: string | null = null): AgentDefinitionInfo {
  return { id, name, sessionType: "shell", config: {}, persistent: false, folderId };
}

function folder(id: string, name: string, parentId: string | null = null): AgentFolderInfo {
  return { id, name, parentId, isExpanded: false };
}

describe("agentDefinitionMatchesQuery", () => {
  it("matches everything on an empty query", () => {
    expect(agentDefinitionMatchesQuery(def("d1", "Anything"), "")).toBe(true);
  });

  it("matches by (case-insensitive) name substring", () => {
    expect(agentDefinitionMatchesQuery(def("d1", "Web Server"), "web")).toBe(true);
    expect(agentDefinitionMatchesQuery(def("d1", "Web Server"), "db")).toBe(false);
  });

  it("matches by name ignoring diacritics (match-sorter normalization)", () => {
    expect(agentDefinitionMatchesQuery(def("d1", "Café Runner"), "cafe")).toBe(true);
  });

  it("keeps substring semantics: an unordered character set is not a match", () => {
    expect(agentDefinitionMatchesQuery(def("d1", "Web Server"), "ws")).toBe(false);
  });
});

describe("agentNameMatchesQuery", () => {
  it("matches everything on an empty query", () => {
    expect(agentNameMatchesQuery("Dev Agent (dev0)", "")).toBe(true);
  });

  it("matches by (case-insensitive) name substring", () => {
    expect(agentNameMatchesQuery("Dev Agent (dev0)", "dev0")).toBe(true);
    expect(agentNameMatchesQuery("Dev Agent (dev0)", "prod")).toBe(false);
  });

  it("matches ignoring diacritics", () => {
    expect(agentNameMatchesQuery("Zürich Agent", "zurich")).toBe(true);
  });
});

describe("filterAgentTree", () => {
  it("returns null for an empty query", () => {
    expect(filterAgentTree("  ", [], [])).toBeNull();
  });

  it("keeps only matching definitions and their ancestor folders", () => {
    const folders = [folder("f1", "Prod"), folder("f2", "Nested", "f1")];
    const definitions = [
      def("d1", "web-01", "f2"),
      def("d2", "db-01", "f2"),
      def("d3", "root-web", null),
    ];
    const result = filterAgentTree("web", folders, definitions);
    expect(result).not.toBeNull();
    expect([...result!.matchingDefinitionIds].sort()).toEqual(["d1", "d3"]);
    // f2 holds a match, f1 is its ancestor — both visible; no unrelated folders.
    expect([...result!.visibleFolderIds].sort()).toEqual(["f1", "f2"]);
  });

  it("marks no folders visible when only a root definition matches", () => {
    const folders = [folder("f1", "Prod")];
    const definitions = [def("d1", "web-01", null), def("d2", "db-01", "f1")];
    const result = filterAgentTree("web", folders, definitions);
    expect([...result!.matchingDefinitionIds]).toEqual(["d1"]);
    expect(result!.visibleFolderIds.size).toBe(0);
  });
});
