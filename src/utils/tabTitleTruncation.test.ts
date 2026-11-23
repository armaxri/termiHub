import { describe, it, expect } from "vitest";
import { splitTabTitle, TAB_TITLE_TAIL_CHARS } from "./tabTitleTruncation";

describe("splitTabTitle (#5827)", () => {
  it("keeps the unique end of an id-like name in the tail", () => {
    expect(splitTabTitle("sys-pr-telnet-0d8db725")).toEqual({
      head: "sys-pr-telnet-",
      tail: "0d8db725",
    });
  });

  it("keeps the duplicate counter in the tail, after the end of the name", () => {
    expect(splitTabTitle("sys-pr-ssh-dup-0d8db725 (2)")).toEqual({
      head: "sys-pr-ssh-dup-",
      tail: "0d8db725 (2)",
    });
  });

  it("moves only the counter of a short name into the tail", () => {
    expect(splitTabTitle("web (12)")).toEqual({ head: "web", tail: " (12)" });
  });

  it("does not split a short name", () => {
    expect(splitTabTitle("Lab switch")).toEqual({ head: "Lab switch", tail: "" });
    expect(splitTabTitle("")).toEqual({ head: "", tail: "" });
  });

  it("does not treat a parenthesised word as a counter", () => {
    const { tail } = splitTabTitle("Startup question (zsh)");
    expect(tail).toBe("on (zsh)");
    expect(tail).toHaveLength(TAB_TITLE_TAIL_CHARS);
  });

  it("never cuts a surrogate pair in half", () => {
    const title = "release-dashboard-🚀🚀🚀🚀🚀🚀🚀🚀";
    const { head, tail } = splitTabTitle(title);
    expect(head + tail).toBe(title);
    expect(Array.from(tail)).toHaveLength(TAB_TITLE_TAIL_CHARS);
    expect(tail).toBe("🚀".repeat(8));
  });

  it("always rejoins to the full title", () => {
    for (const title of ["a", "Production database replica 12", "x".repeat(40) + " (3)"]) {
      const { head, tail } = splitTabTitle(title);
      expect(head + tail).toBe(title);
    }
  });
});
