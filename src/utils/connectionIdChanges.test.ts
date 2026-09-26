import { describe, it, expect } from "vitest";
import {
  connectionIdRemapper,
  remapConnectionIdList,
  remapJumpHostRefs,
  remapTabContentConnectionIds,
  remapWorkflowTriggers,
  remapWorkspaceTabGroups,
} from "./connectionIdChanges";
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
