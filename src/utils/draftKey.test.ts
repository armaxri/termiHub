import { describe, it, expect } from "vitest";
import { draftKey } from "./draftKey";

describe("draftKey", () => {
  it("ignores object key order at every level", () => {
    expect(draftKey({ a: 1, b: { c: 2, d: 3 } })).toBe(draftKey({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("keeps array order, since reordering is an edit", () => {
    expect(draftKey([1, 2])).not.toBe(draftKey([2, 1]));
  });

  it("treats an undefined member like an absent one", () => {
    expect(draftKey({ a: 1, b: undefined })).toBe(draftKey({ a: 1 }));
  });

  it("tells a changed value apart", () => {
    expect(draftKey({ name: "x" })).not.toBe(draftKey({ name: "y" }));
  });
});
