import { describe, it, expect } from "vitest";
import { mergeMovedDraft } from "./mergeFormDraft";

describe("mergeMovedDraft (#4760)", () => {
  const base = { fontSize: 13, theme: "dark", nested: { a: 1, b: 2 }, list: [1, 2] };

  it("takes every moved change when the local draft is clean", () => {
    const moved = { ...base, fontSize: 18, nested: { a: 1, b: 5 } };
    expect(mergeMovedDraft(base, moved, base)).toEqual({ values: moved, conflicts: [] });
  });

  it("keeps local changes the moved draft did not touch", () => {
    const local = { ...base, theme: "light" };
    const moved = { ...base, fontSize: 18 };
    expect(mergeMovedDraft(local, moved, base)).toEqual({
      values: { ...base, theme: "light", fontSize: 18 },
      conflicts: [],
    });
  });

  it("keeps the local value and reports a field both changed differently", () => {
    const local = { ...base, fontSize: 20, nested: { a: 9, b: 2 } };
    const moved = { ...base, fontSize: 18, nested: { a: 7, b: 3 } };
    expect(mergeMovedDraft(local, moved, base)).toEqual({
      values: { ...base, fontSize: 20, nested: { a: 9, b: 3 } },
      conflicts: ["fontSize", "nested.a"],
    });
  });

  it("does not report a field both changed to the same value", () => {
    const local = { ...base, fontSize: 18 };
    const moved = { ...base, fontSize: 18 };
    expect(mergeMovedDraft(local, moved, base).conflicts).toEqual([]);
  });

  it("compares arrays as a whole", () => {
    const local = { ...base, list: [1, 2, 3] };
    const moved = { ...base, list: [0] };
    expect(mergeMovedDraft(local, moved, base)).toEqual({ values: local, conflicts: ["list"] });
  });

  it("applies a key the moved draft added or removed", () => {
    const moved: Record<string, unknown> = { ...base, extra: true };
    delete moved.theme;
    const values = mergeMovedDraft(base, moved, base).values as Record<string, unknown>;
    expect(values.extra).toBe(true);
    expect("theme" in values).toBe(false);
  });

  it("keeps a local key absent from the moved draft and the base", () => {
    const local = { ...base, apiToken: "typed-here" };
    expect(mergeMovedDraft(local, base, base).values).toEqual(local);
  });
});
