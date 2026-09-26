/** Transfer-pane cursor and range-selection helpers (PROD-007, #3558). */
import { describe, it, expect } from "vitest";
import type { FileEntry } from "@/types/connection";
import { nextPaneCursor, rangeSelection } from "./paneSelection";

const entries = ["a", "b", "c", "d"].map(
  (n) => ({ name: n, path: `/${n}`, isDirectory: false }) as FileEntry
);

describe("nextPaneCursor", () => {
  it("moves and clamps with the arrow keys", () => {
    expect(nextPaneCursor("ArrowDown", 0, 4)).toBe(1);
    expect(nextPaneCursor("ArrowDown", 3, 4)).toBe(3);
    expect(nextPaneCursor("ArrowUp", 0, 4)).toBe(0);
    expect(nextPaneCursor("ArrowUp", 2, 4)).toBe(1);
  });

  it("jumps with Home/End and pages by ten", () => {
    expect(nextPaneCursor("Home", 2, 4)).toBe(0);
    expect(nextPaneCursor("End", 0, 4)).toBe(3);
    expect(nextPaneCursor("PageDown", 0, 40)).toBe(10);
    expect(nextPaneCursor("PageUp", 5, 40)).toBe(0);
  });

  it("ignores other keys and empty lists", () => {
    expect(nextPaneCursor("Enter", 0, 4)).toBeNull();
    expect(nextPaneCursor("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("rangeSelection", () => {
  it("selects the inclusive range in either direction", () => {
    expect([...rangeSelection(entries, 1, 3)]).toEqual(["/b", "/c", "/d"]);
    expect([...rangeSelection(entries, 2, 0)]).toEqual(["/a", "/b", "/c"]);
  });
});
