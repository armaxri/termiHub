import { describe, it, expect } from "vitest";
import type { FileEntry } from "@/types/connection";
import {
  describeEntries,
  findNameConflicts,
  isSameOrDescendant,
  joinDirPath,
  parentDirPath,
  planFileDrop,
} from "./fileDragMove";

function entry(path: string, isDirectory = false, writable: boolean | null = null): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    isDirectory,
    size: 0,
    modified: "",
    permissions: null,
    writable,
  };
}

describe("path helpers", () => {
  it("joins and splits paths on POSIX and Windows-style roots", () => {
    expect(joinDirPath("/", "a")).toBe("/a");
    expect(joinDirPath("/home/u/", "a")).toBe("/home/u/a");
    expect(joinDirPath("C:/", "a")).toBe("C:/a");
    expect(parentDirPath("/a")).toBe("/");
    expect(parentDirPath("/home/u/a.txt")).toBe("/home/u");
    expect(parentDirPath("C:/a.txt")).toBe("C:/");
    expect(parentDirPath("C:\\Users\\a.txt")).toBe("C:/Users");
  });

  it("detects self and descendant destinations without prefix false-positives", () => {
    expect(isSameOrDescendant("/a/src", "/a/src")).toBe(true);
    expect(isSameOrDescendant("/a/src", "/a/src/deep/er")).toBe(true);
    expect(isSameOrDescendant("/a/src", "/a/src2")).toBe(false);
    expect(isSameOrDescendant("/a/src", "/a")).toBe(false);
  });
});

describe("planFileDrop", () => {
  it("accepts a move of a file into a sibling folder", () => {
    const f = entry("/home/u/a.txt");
    expect(planFileDrop([f], "/home/u/docs", "move")).toEqual({ kind: "ok", entries: [f] });
  });

  it("refuses moving a folder into itself", () => {
    const d = entry("/home/u/docs", true);
    const plan = planFileDrop([d], "/home/u/docs", "move");
    expect(plan).toMatchObject({ kind: "refuse", reason: "into-self" });
  });

  it("refuses moving or copying a folder into one of its descendants", () => {
    const d = entry("/home/u/docs", true);
    expect(planFileDrop([d], "/home/u/docs/sub", "move")).toMatchObject({
      kind: "refuse",
      reason: "into-self",
    });
    expect(planFileDrop([d], "/home/u/docs/sub", "copy")).toMatchObject({
      kind: "refuse",
      reason: "into-self",
    });
  });

  it("refuses a destination folder reported read-only", () => {
    const f = entry("/srv/a.txt");
    const dest = entry("/srv/locked", true, false);
    expect(planFileDrop([f], dest.path, "move", dest)).toMatchObject({
      kind: "refuse",
      reason: "read-only",
    });
  });

  it("allows a destination whose writability is unknown", () => {
    const f = entry("/srv/a.txt");
    const dest = entry("/srv/maybe", true, null);
    expect(planFileDrop([f], dest.path, "move", dest).kind).toBe("ok");
  });

  it("treats a drop into the entries' current folder as a no-op (move and copy)", () => {
    const f = entry("/home/u/a.txt");
    expect(planFileDrop([f], "/home/u", "move")).toEqual({ kind: "noop" });
    expect(planFileDrop([f], "/home/u/", "copy")).toEqual({ kind: "noop" });
  });

  it("keeps only entries that actually change folder in a mixed multi-select", () => {
    const a = entry("/home/u/a.txt");
    const b = entry("/home/u/docs/b.txt");
    expect(planFileDrop([a, b], "/home/u/docs", "move")).toEqual({ kind: "ok", entries: [a] });
  });

  it("refuses an empty request", () => {
    expect(planFileDrop([], "/x", "move")).toMatchObject({ kind: "refuse", reason: "empty" });
  });
});

describe("findNameConflicts / describeEntries", () => {
  it("lists entry names already present in the destination", () => {
    const a = entry("/x/a.txt");
    const b = entry("/x/b.txt");
    expect(findNameConflicts([a, b], ["b.txt", "c.txt"])).toEqual(["b.txt"]);
    expect(findNameConflicts([a], [])).toEqual([]);
  });

  it("describes one entry by name and several by count", () => {
    expect(describeEntries([entry("/x/a.txt")])).toBe('"a.txt"');
    expect(describeEntries([entry("/x/a"), entry("/x/b")])).toBe("2 items");
  });
});
