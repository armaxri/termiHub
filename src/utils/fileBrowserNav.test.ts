import { describe, it, expect } from "vitest";
import {
  splitPathSegments,
  sortEntries,
  filterEntries,
  findTypeAheadIndex,
} from "./fileBrowserNav";
import type { FileEntry } from "@/types/connection";

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: `/${name}`,
    isDirectory: false,
    size: 0,
    modified: "2026-01-01T00:00:00Z",
    permissions: null,
    ...over,
  };
}

describe("splitPathSegments", () => {
  it("splits a POSIX path into cumulative crumbs", () => {
    expect(splitPathSegments("/home/user/projects")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "user", path: "/home/user" },
      { label: "projects", path: "/home/user/projects" },
    ]);
  });

  it("returns a single root crumb for '/'", () => {
    expect(splitPathSegments("/")).toEqual([{ label: "/", path: "/" }]);
  });

  it("splits a Windows drive path with the drive as root", () => {
    expect(splitPathSegments("C:/Users/test")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "test", path: "C:/Users/test" },
    ]);
  });

  it("normalizes backslashes before splitting", () => {
    expect(splitPathSegments("C:\\Users\\test")).toEqual([
      { label: "C:", path: "C:/" },
      { label: "Users", path: "C:/Users" },
      { label: "test", path: "C:/Users/test" },
    ]);
  });

  it("keeps the WSL UNC prefix as a single root crumb", () => {
    expect(splitPathSegments("//wsl$/Ubuntu/home/user")).toEqual([
      { label: "//wsl$/Ubuntu", path: "//wsl$/Ubuntu" },
      { label: "home", path: "//wsl$/Ubuntu/home" },
      { label: "user", path: "//wsl$/Ubuntu/home/user" },
    ]);
  });

  it("treats a bare drive root as a single crumb", () => {
    expect(splitPathSegments("C:/")).toEqual([{ label: "C:", path: "C:/" }]);
  });

  it("returns an empty array for an empty path", () => {
    expect(splitPathSegments("")).toEqual([]);
  });
});

describe("sortEntries", () => {
  const entries: FileEntry[] = [
    entry("banana.txt", { size: 30, modified: "2026-01-03T00:00:00Z" }),
    entry("apple.txt", { size: 10, modified: "2026-01-01T00:00:00Z" }),
    entry("zeta", { isDirectory: true, size: 0, modified: "2026-01-05T00:00:00Z" }),
    entry("cherry.txt", { size: 20, modified: "2026-01-02T00:00:00Z" }),
    entry("alpha", { isDirectory: true, size: 0, modified: "2026-01-04T00:00:00Z" }),
  ];

  it("always groups directories before files", () => {
    const sorted = sortEntries(entries, "name", "asc");
    expect(sorted.slice(0, 2).every((e) => e.isDirectory)).toBe(true);
    expect(sorted.slice(2).every((e) => !e.isDirectory)).toBe(true);
  });

  it("sorts by name ascending within groups", () => {
    const sorted = sortEntries(entries, "name", "asc");
    expect(sorted.map((e) => e.name)).toEqual([
      "alpha",
      "zeta",
      "apple.txt",
      "banana.txt",
      "cherry.txt",
    ]);
  });

  it("sorts by name descending within groups but keeps dirs first", () => {
    const sorted = sortEntries(entries, "name", "desc");
    expect(sorted.map((e) => e.name)).toEqual([
      "zeta",
      "alpha",
      "cherry.txt",
      "banana.txt",
      "apple.txt",
    ]);
  });

  it("sorts files by size ascending", () => {
    const sorted = sortEntries(entries, "size", "asc").filter((e) => !e.isDirectory);
    expect(sorted.map((e) => e.name)).toEqual(["apple.txt", "cherry.txt", "banana.txt"]);
  });

  it("sorts files by modified time descending", () => {
    const sorted = sortEntries(entries, "modified", "desc").filter((e) => !e.isDirectory);
    expect(sorted.map((e) => e.name)).toEqual(["banana.txt", "cherry.txt", "apple.txt"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...entries];
    sortEntries(entries, "size", "desc");
    expect(entries).toEqual(copy);
  });
});

describe("filterEntries", () => {
  const entries: FileEntry[] = [entry("README.md"), entry("main.rs"), entry("Cargo.toml")];

  it("returns all entries for an empty query", () => {
    expect(filterEntries(entries, "")).toHaveLength(3);
  });

  it("filters case-insensitively by substring", () => {
    expect(filterEntries(entries, "ar").map((e) => e.name)).toEqual(["Cargo.toml"]);
  });

  it("matches the readme regardless of case", () => {
    expect(filterEntries(entries, "readme").map((e) => e.name)).toEqual(["README.md"]);
  });
});

describe("findTypeAheadIndex", () => {
  const entries: FileEntry[] = [entry("alpha"), entry("apple"), entry("banana"), entry("cherry")];
  const byName = (e: FileEntry) => e.name;

  it("finds the first match advancing past the current index", () => {
    expect(findTypeAheadIndex(entries, byName, "a", 0, true)).toBe(1);
  });

  it("stays on the current match when extending the buffer", () => {
    expect(findTypeAheadIndex(entries, byName, "ap", 1, false)).toBe(1);
  });

  it("wraps around to the start", () => {
    expect(findTypeAheadIndex(entries, byName, "a", 1, true)).toBe(0);
  });

  it("returns -1 when nothing matches", () => {
    expect(findTypeAheadIndex(entries, byName, "z", 0, true)).toBe(-1);
  });

  it("returns -1 for an empty buffer", () => {
    expect(findTypeAheadIndex(entries, byName, "", 0, true)).toBe(-1);
  });
});
