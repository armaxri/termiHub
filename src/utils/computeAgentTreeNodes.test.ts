import { describe, it, expect } from "vitest";
import { computeAgentTreeNodes } from "./computeAgentTreeNodes";
import { filterAgentTree } from "./agentTreeSearch";
import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";

function def(id: string, name: string, folderId: string | null = null): AgentDefinitionInfo {
  return { id, name, sessionType: "shell", config: {}, persistent: false, folderId };
}

function folder(
  id: string,
  name: string,
  parentId: string | null = null,
  isExpanded = true
): AgentFolderInfo {
  return { id, name, parentId, isExpanded };
}

function session(id: string, title: string): AgentSessionInfo {
  return { sessionId: id, title, type: "shell", status: "running", attached: false };
}

describe("computeAgentTreeNodes", () => {
  it("lists sessions first, then folders (with children), then root definitions", () => {
    const sessions = [session("s1", "Live")];
    const folders = [folder("f1", "Prod")];
    const definitions = [def("d1", "web", "f1"), def("d2", "root-conn", null)];

    const nodes = computeAgentTreeNodes(sessions, folders, definitions, null);
    expect(nodes.map((n) => `${n.kind}:${n.id}`)).toEqual([
      "session:s1",
      "folder:f1",
      "definition:d1",
      "definition:d2",
    ]);
    const f1 = nodes.find((n) => n.id === "f1")!;
    expect(f1.hasChildren).toBe(true);
    expect(f1.isExpanded).toBe(true);
    // Nested definition is one level deeper than its folder.
    const d1 = nodes.find((n) => n.id === "d1")!;
    expect(d1.depth).toBe(nodes.find((n) => n.id === "f1")!.depth + 1);
    expect(d1.parentId).toBe("f1");
  });

  it("omits children of collapsed folders", () => {
    const folders = [folder("f1", "Prod", null, false)];
    const definitions = [def("d1", "web", "f1")];
    const nodes = computeAgentTreeNodes([], folders, definitions, null);
    expect(nodes.map((n) => n.id)).toEqual(["f1"]);
    expect(nodes[0].isExpanded).toBe(false);
  });

  it("under an active filter, includes only matches + ancestors and force-expands them", () => {
    // Folder stored collapsed, but the filter force-expands it to reveal a match.
    const folders = [folder("f1", "Prod", null, false), folder("f2", "Other", null, false)];
    const definitions = [def("d1", "web", "f1"), def("d2", "db", "f1"), def("d3", "cache", "f2")];
    const filter = filterAgentTree("web", folders, definitions);

    const nodes = computeAgentTreeNodes([], folders, definitions, filter);
    expect(nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(["folder:f1", "definition:d1"]);
    expect(nodes.find((n) => n.id === "f1")!.isExpanded).toBe(true);
  });

  it("keeps sessions visible even under an active filter", () => {
    const sessions = [session("s1", "Live")];
    const definitions = [def("d1", "web", null), def("d2", "db", null)];
    const filter = filterAgentTree("web", [], definitions);
    const nodes = computeAgentTreeNodes(sessions, [], definitions, filter);
    expect(nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(["session:s1", "definition:d1"]);
  });
});
