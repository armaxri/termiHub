import { describe, it, expect } from "vitest";
import { parseIssueRefs } from "./parse-issue-refs.mjs";

describe("parseIssueRefs", () => {
  it("parses a single closing keyword", () => {
    expect(parseIssueRefs("Closes #42")).toEqual([42]);
  });

  it("recognizes all GitHub closing keywords case-insensitively", () => {
    for (const kw of [
      "close",
      "closes",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
      "CLOSES",
      "Fixes",
      "ReSoLvEd",
    ]) {
      expect(parseIssueRefs(`${kw} #7`)).toEqual([7]);
    }
  });

  it("accepts an optional colon and flexible whitespace", () => {
    expect(parseIssueRefs("Closes: #5")).toEqual([5]);
    expect(parseIssueRefs("fixes:#9")).toEqual([9]);
    expect(parseIssueRefs("Resolves   #11")).toEqual([11]);
  });

  it("collects multiple references and de-duplicates them, sorted", () => {
    const body = "Fixes #34, closes #12 and resolves #34. Also closes #3.";
    expect(parseIssueRefs(body)).toEqual([3, 12, 34]);
  });

  it("ignores bare issue numbers without a keyword", () => {
    expect(parseIssueRefs("See #42 for context")).toEqual([]);
    expect(parseIssueRefs("Part of #100")).toEqual([]);
  });

  it("does not match keywords embedded in larger words", () => {
    expect(parseIssueRefs("disclosed #5")).toEqual([]);
    expect(parseIssueRefs("prefixes #5")).toEqual([]);
  });

  it("returns an empty array for empty or non-string input", () => {
    expect(parseIssueRefs("")).toEqual([]);
    expect(parseIssueRefs(null)).toEqual([]);
    expect(parseIssueRefs(undefined)).toEqual([]);
  });

  it("parses references spread across multiple lines", () => {
    const body = ["Implements the feature.", "", "Closes #80", "Fixes #81"].join("\n");
    expect(parseIssueRefs(body)).toEqual([80, 81]);
  });
});
