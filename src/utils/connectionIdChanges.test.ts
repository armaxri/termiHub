import { describe, it, expect } from "vitest";
import {
  connectionIdRemapper,
  inferFolderFollow,
  remapConnectionIdList,
  remapJumpHostRefs,
  remapPersistentSessions,
  remapTabContentConnectionIds,
  remapWorkflowTriggers,
  remapWorkspaceTabGroups,
} from "./connectionIdChanges";
import type { PersistentSessionEntry } from "@/types/connection";
import type { TabContent } from "@/types/terminal";
import type { WorkflowTrigger } from "@/types/workflow";
import type { WorkspaceTabGroupDef } from "@/types/workspace";

function content(id: string, refs: Partial<TabContent>): TabContent {
  return {
    id,
    sessionId: null,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    ...refs,
  };
}

describe("connectionIdRemapper", () => {
  it("maps changed ids and leaves the rest", () => {
    const remap = connectionIdRemapper([{ oldId: "a", newId: "b" }]);
    expect(remap("a")).toBe("b");
    expect(remap("z")).toBe("z");
  });

  it("applies a batch simultaneously (swap, no compounding chain)", () => {
    const remap = connectionIdRemapper([
      { oldId: "a", newId: "b" },
      { oldId: "b", newId: "c" },
      { oldId: "x", newId: "y" },
      { oldId: "y", newId: "x" },
    ]);
    expect(remap("a")).toBe("b");
    expect(remap("b")).toBe("c");
    expect(remap("x")).toBe("y");
    expect(remap("y")).toBe("x");
  });
});

describe("remapTabContentConnectionIds", () => {
  it("remaps both references and keeps unrelated entries by identity", () => {
    const other = content("other", { connectionId: "keep" });
    const tabs = {
      t1: content("t1", { connectionId: "a", persistentConnectionId: "a" }),
      other,
    };
    const next = remapTabContentConnectionIds(tabs, [{ oldId: "a", newId: "b" }]);
    expect(next?.t1.connectionId).toBe("b");
    expect(next?.t1.persistentConnectionId).toBe("b");
    expect(next?.other).toBe(other);
    // The input is not mutated.
    expect(tabs.t1.connectionId).toBe("a");
  });

  it("re-points an open connection editor's own connection (#3622)", () => {
    const tabs = {
      ed: content("ed", {
        contentType: "connection-editor",
        connectionEditorMeta: { connectionId: "Work/x", folderId: null },
      }),
      def: content("def", {
        contentType: "connection-editor",
        connectionEditorMeta: { connectionId: "Work/x", folderId: null, agentDefinitionId: "d1" },
      }),
      fresh: content("fresh", {
        contentType: "connection-editor",
        connectionEditorMeta: { connectionId: "new", folderId: "Work" },
      }),
    };
    const next = remapTabContentConnectionIds(tabs, [{ oldId: "Work/x", newId: "Job/x" }]);
    expect(next?.ed.connectionEditorMeta).toEqual({ connectionId: "Job/x", folderId: null });
    // An agent-definition editor's id is an agent id, and a new editor has none.
    expect(next?.def).toBe(tabs.def);
    expect(next?.fresh).toBe(tabs.fresh);
  });

  it("returns null when nothing references a changed id", () => {
    const tabs = { t1: content("t1", { connectionId: "keep" }), t2: content("t2", {}) };
    expect(remapTabContentConnectionIds(tabs, [{ oldId: "a", newId: "b" }])).toBeNull();
    expect(remapTabContentConnectionIds(tabs, [])).toBeNull();
  });
});

describe("draft remappers (#3603)", () => {
  const remap = connectionIdRemapper([
    { oldId: "a", newId: "b" },
    { oldId: "b", newId: "a" },
  ]);
  const none = connectionIdRemapper([{ oldId: "zz", newId: "yy" }]);

  it("remapConnectionIdList swaps and keeps identity when unchanged", () => {
    expect(remapConnectionIdList(["a", "b", "c"], remap)).toEqual(["b", "a", "c"]);
    const ids = ["a"];
    expect(remapConnectionIdList(ids, none)).toBe(ids);
  });

  it("remapWorkspaceTabGroups re-points nested tab refs only", () => {
    const untouched: WorkspaceTabGroupDef = {
      name: "Other",
      layout: { type: "leaf", tabs: [{ inlineConfig: { type: "local", config: {} } }] },
    };
    const groups: WorkspaceTabGroupDef[] = [
      {
        name: "Main",
        layout: {
          type: "split",
          direction: "horizontal",
          children: [
            { type: "leaf", tabs: [{ connectionRef: "a", title: "A" }, { connectionRef: "c" }] },
            { type: "leaf", tabs: [{ connectionRef: "b" }] },
          ],
        },
      },
      untouched,
    ];
    const next = remapWorkspaceTabGroups(groups, remap);
    expect(next[0].layout).toEqual({
      type: "split",
      direction: "horizontal",
      children: [
        { type: "leaf", tabs: [{ connectionRef: "b", title: "A" }, { connectionRef: "c" }] },
        { type: "leaf", tabs: [{ connectionRef: "a" }] },
      ],
    });
    expect(next[1]).toBe(untouched);
    expect(remapWorkspaceTabGroups(groups, none)).toBe(groups);
  });

  it("remapWorkflowTriggers re-points on-connect triggers only", () => {
    const triggers: WorkflowTrigger[] = [
      { kind: "manual" },
      { kind: "on-connect", connectionIds: ["a", "c"] },
    ];
    expect(remapWorkflowTriggers(triggers, remap)).toEqual([
      { kind: "manual" },
      { kind: "on-connect", connectionIds: ["b", "c"] },
    ]);
    expect(remapWorkflowTriggers(triggers, none)).toBe(triggers);
  });

  it("remapJumpHostRefs re-points proxyJump and legacy jumpHosts hops", () => {
    const settings = {
      host: "h",
      proxyJump: [{ connectionId: "a", host: "" }, { host: "inline" }],
      jumpHosts: [{ connectionId: "b" }],
    };
    expect(remapJumpHostRefs(settings, remap)).toEqual({
      host: "h",
      proxyJump: [{ connectionId: "b", host: "" }, { host: "inline" }],
      jumpHosts: [{ connectionId: "a" }],
    });
    expect(remapJumpHostRefs(settings, none)).toBe(settings);
    const plain = { host: "h" };
    expect(remapJumpHostRefs(plain, remap)).toBe(plain);
  });
});

describe("inferFolderFollow (#3622)", () => {
  const before = ["Work/x", "Work/sub/y", "Other/z", "root"];

  it("follows a folder rename or move", () => {
    const changes = [
      { oldId: "Work/x", newId: "Job/x" },
      { oldId: "Work/sub/y", newId: "Job/sub/y" },
    ];
    expect(inferFolderFollow("Work", changes, before)).toEqual({ from: "Work", to: "Job" });
    expect(inferFolderFollow("Work/sub", changes, before)).toEqual({
      from: "Work/sub",
      to: "Job/sub",
    });
    const moved = [
      { oldId: "Work/x", newId: "Other/Work/x" },
      { oldId: "Work/sub/y", newId: "Other/Work/sub/y" },
    ];
    expect(inferFolderFollow("Work", moved, before)).toEqual({ from: "Work", to: "Other/Work" });
  });

  it("follows a deleted folder's contents up to the root", () => {
    const changes = [
      { oldId: "Work/x", newId: "x" },
      { oldId: "Work/sub/y", newId: "sub/y" },
    ];
    expect(inferFolderFollow("Work", changes, before)).toEqual({ from: "Work", to: null });
  });

  it("returns null when the folder's connections did not all move together", () => {
    // Only one of the folder's connections moved.
    expect(inferFolderFollow("Work", [{ oldId: "Work/x", newId: "Job/x" }], before)).toBeNull();
    // A rename of the connection itself, not of the folder.
    expect(
      inferFolderFollow("Work/sub", [{ oldId: "Work/sub/y", newId: "Work/sub/w" }], before)
    ).toBeNull();
    // An empty folder / untouched folder.
    expect(inferFolderFollow("Empty", [{ oldId: "Work/x", newId: "Job/x" }], before)).toBeNull();
    expect(inferFolderFollow("Other", [{ oldId: "Work/x", newId: "Job/x" }], before)).toBeNull();
  });
});

describe("remapPersistentSessions (#3595)", () => {
  const entry = (connectionId: string, sessionId: string): PersistentSessionEntry => ({
    connectionId,
    sessionId,
    state: "running",
    attachedTabIds: [],
  });

  it("moves entries and their connectionId, applying a chain simultaneously", () => {
    const next = remapPersistentSessions({ a: entry("a", "sa"), b: entry("b", "sb") }, [
      { oldId: "a", newId: "b" },
      { oldId: "b", newId: "c" },
    ]);
    expect(next).toEqual({ b: entry("b", "sa"), c: entry("c", "sb") });
  });

  it("exchanges a swap", () => {
    const next = remapPersistentSessions({ a: entry("a", "sa"), b: entry("b", "sb") }, [
      { oldId: "a", newId: "b" },
      { oldId: "b", newId: "a" },
    ]);
    expect(next).toEqual({ a: entry("a", "sb"), b: entry("b", "sa") });
  });

  it("never displaces an entry that does not move away (the backend keeps it too)", () => {
    const sessions = { a: entry("a", "sa"), b: entry("b", "stale") };
    expect(remapPersistentSessions(sessions, [{ oldId: "a", newId: "b" }])).toBeNull();
  });

  it("returns null when no entry moved", () => {
    expect(
      remapPersistentSessions({ a: entry("a", "sa") }, [{ oldId: "x", newId: "y" }])
    ).toBeNull();
    expect(remapPersistentSessions({}, [])).toBeNull();
  });
});
