import { describe, it, expect } from "vitest";
import { computeFlatVisibleIds } from "./computeFlatVisibleIds";

const f = (id: string, parentId: string | null, isExpanded: boolean) => ({
  id,
  parentId,
  isExpanded,
});
const item = (id: string, folderId: string | null) => ({ id, folderId });

describe("computeFlatVisibleIds", () => {
  it("returns root items when there are no folders", () => {
    const result = computeFlatVisibleIds(
      [],
      [item("a", null), item("b", null)],
      [],
      [item("a", null), item("b", null)]
    );
    expect(result).toEqual(["a", "b"]);
  });

  it("excludes items inside collapsed folders", () => {
    const folders = [f("f1", null, false)];
    const items = [item("a", null), item("b", "f1")];
    expect(computeFlatVisibleIds(folders, [item("a", null)], folders, items)).toEqual(["a"]);
  });

  it("includes items inside expanded folders", () => {
    const folders = [f("f1", null, true)];
    const items = [item("a", "f1"), item("b", null)];
    expect(computeFlatVisibleIds(folders, [item("b", null)], folders, items)).toEqual(["a", "b"]);
  });

  it("traverses nested expanded folders depth-first", () => {
    const folders = [f("f1", null, true), f("f2", "f1", true)];
    const items = [item("a", "f2"), item("b", "f1"), item("c", null)];
    expect(computeFlatVisibleIds([f("f1", null, true)], [item("c", null)], folders, items)).toEqual(
      ["a", "b", "c"]
    );
  });

  it("stops traversal at collapsed nested folder", () => {
    const folders = [f("f1", null, true), f("f2", "f1", false)];
    const items = [item("a", "f2"), item("b", "f1"), item("c", null)];
    expect(computeFlatVisibleIds([f("f1", null, true)], [item("c", null)], folders, items)).toEqual(
      ["b", "c"]
    );
  });
});
