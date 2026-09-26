import { describe, it, expect } from "vitest";
import { connectionIdRemapper, remapTabContentConnectionIds } from "./connectionIdChanges";
import type { TabContent } from "@/types/terminal";

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
