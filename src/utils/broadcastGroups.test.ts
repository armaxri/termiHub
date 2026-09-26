import { describe, it, expect } from "vitest";
import type { TerminalTab } from "@/types/terminal";
import {
  groupableConnectionIds,
  MAX_BROADCAST_GROUP_NAME_LENGTH,
  normalizeBroadcastGroupName,
  removeBroadcastGroup,
  resolveBroadcastGroup,
  sanitizeBroadcastGroups,
  upsertBroadcastGroup,
  validateBroadcastGroupName,
} from "./broadcastGroups";

function tab(
  id: string,
  connectionId?: string,
  contentType: TerminalTab["contentType"] = "terminal"
) {
  return {
    id,
    sessionId: `s-${id}`,
    title: id,
    connectionType: "ssh",
    contentType,
    config: { type: "ssh", config: {} },
    panelId: "p",
    isActive: false,
    connectionId,
  } as TerminalTab;
}

describe("broadcast group names (PROD-061)", () => {
  it("normalizes whitespace", () => {
    expect(normalizeBroadcastGroupName("  web   servers ")).toBe("web servers");
  });

  it("rejects empty and over-long names", () => {
    expect(validateBroadcastGroupName("   ")).toMatch(/Enter a group name/);
    expect(validateBroadcastGroupName("x".repeat(MAX_BROADCAST_GROUP_NAME_LENGTH + 1))).toMatch(
      /at most/
    );
    expect(validateBroadcastGroupName("web")).toBeNull();
  });
});

describe("groupableConnectionIds (PROD-061)", () => {
  it("keeps only selected terminals with a saved connection, de-duplicated", () => {
    const tabs = [tab("a", "c1"), tab("b", "c1"), tab("c"), tab("d", "c2"), tab("e", "c3")];
    expect(groupableConnectionIds(tabs, ["a", "b", "c", "d"])).toEqual({
      connectionIds: ["c1", "c2"],
      unsavedCount: 1,
    });
  });

  it("ignores non-terminal tabs", () => {
    expect(groupableConnectionIds([tab("a", "c1", "editor")], ["a"])).toEqual({
      connectionIds: [],
      unsavedCount: 0,
    });
  });
});

describe("resolveBroadcastGroup (PROD-061)", () => {
  const group = { id: "g", name: "web", connectionIds: ["c1", "c2", "c9"] };

  it("resolves every open terminal of a member connection and lists missing members", () => {
    const tabs = [tab("a", "c1"), tab("b", "c2"), tab("c", "c1"), tab("d", "c3"), tab("e")];
    expect(resolveBroadcastGroup(tabs, group)).toEqual({
      tabIds: ["a", "b", "c"],
      missingConnectionIds: ["c9"],
    });
  });

  it("never matches ad-hoc tabs or non-terminal tabs", () => {
    const tabs = [tab("a"), tab("b", "c1", "sftp")];
    expect(resolveBroadcastGroup(tabs, group).tabIds).toEqual([]);
  });
});

describe("upsert/remove (PROD-061)", () => {
  it("appends a new group", () => {
    const next = upsertBroadcastGroup([], " web ", ["c1", "c1"], () => "id1");
    expect(next).toEqual([{ id: "id1", name: "web", connectionIds: ["c1"] }]);
  });

  it("replaces a same-named group case-insensitively, keeping its id", () => {
    const groups = [
      { id: "g1", name: "Web", connectionIds: ["c1"] },
      { id: "g2", name: "db", connectionIds: ["c3"] },
    ];
    const next = upsertBroadcastGroup(groups, "web", ["c2"], () => "new");
    expect(next).toEqual([
      { id: "g1", name: "web", connectionIds: ["c2"] },
      { id: "g2", name: "db", connectionIds: ["c3"] },
    ]);
  });

  it("removes by id", () => {
    expect(removeBroadcastGroup([{ id: "g1", name: "a", connectionIds: [] }], "g1")).toEqual([]);
  });
});

describe("sanitizeBroadcastGroups (PROD-061)", () => {
  it("drops malformed entries from a hand-edited settings file", () => {
    expect(
      sanitizeBroadcastGroups([
        { id: "g1", name: " ok ", connectionIds: ["c1", 5, "", "c1"] },
        { id: "", name: "x", connectionIds: [] },
        { id: "g3", name: "   ", connectionIds: [] },
        { id: "g4", name: "no ids" },
        null,
        "junk",
      ])
    ).toEqual([{ id: "g1", name: "ok", connectionIds: ["c1"] }]);
  });

  it("returns [] for a non-array", () => {
    expect(sanitizeBroadcastGroups(undefined)).toEqual([]);
    expect(sanitizeBroadcastGroups({})).toEqual([]);
  });
});
