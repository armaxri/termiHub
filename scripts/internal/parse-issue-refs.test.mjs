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

  describe("inline code spans", () => {
    it("ignores a keyword inside a single-backtick span", () => {
      expect(parseIssueRefs("The template line is `Closes #901` in the body.")).toEqual([]);
    });

    it("ignores a keyword inside a multi-backtick span", () => {
      expect(parseIssueRefs("Write ``Closes #902`` verbatim.")).toEqual([]);
    });

    it("still parses a keyword outside the span on the same line", () => {
      expect(parseIssueRefs("Unlike `Closes #903`, this one really does. Closes #904")).toEqual([
        904,
      ]);
    });

    it("does not treat an unpaired backtick as opening a span", () => {
      expect(parseIssueRefs("A stray ` tick. Closes #905")).toEqual([905]);
    });
  });

  describe("fenced code blocks", () => {
    it("ignores keywords inside a backtick fence", () => {
      const body = ["Example PR body:", "", "```markdown", "Closes #906", "```", ""].join("\n");
      expect(parseIssueRefs(body)).toEqual([]);
    });

    it("ignores keywords inside a tilde fence", () => {
      const body = ["Example:", "", "~~~", "Fixes #907", "~~~"].join("\n");
      expect(parseIssueRefs(body)).toEqual([]);
    });

    it("resumes parsing after the fence closes", () => {
      const body = ["```", "Closes #908", "```", "", "Closes #909"].join("\n");
      expect(parseIssueRefs(body)).toEqual([909]);
    });
  });

  describe("blockquotes", () => {
    it("ignores keywords on quoted lines", () => {
      const body = ["Quoting the other PR:", "", "> Closes #910", "", "This PR does not."].join("\n");
      expect(parseIssueRefs(body)).toEqual([]);
    });

    it("ignores keywords in a nested blockquote", () => {
      expect(parseIssueRefs(">> Resolves #911")).toEqual([]);
    });
  });

  describe("negated keywords", () => {
    it("ignores a directly negated keyword", () => {
      expect(parseIssueRefs("This PR does not close #912.")).toEqual([]);
      expect(parseIssueRefs("It doesn't fix #913.")).toEqual([]);
      expect(parseIssueRefs("This will never resolve #914.")).toEqual([]);
    });

    it("does not let a negation leak across a sentence boundary", () => {
      expect(parseIssueRefs("This is not a refactor. Closes #915")).toEqual([915]);
    });

    it("does not let a negation leak across a line break", () => {
      expect(parseIssueRefs("The parser is not clever\nCloses #916")).toEqual([916]);
    });
  });

  describe("the bodies that caused the real incidents", () => {
    // PR #1564: the body explained that the PR deliberately left work behind, and
    // the bot closed the issue anyway.
    it("does not close an issue the body says it leaves open", () => {
      const body = [
        "Implements the first half of the migration.",
        "",
        "This PR does not close #917 — the remainder is blocked on another issue.",
        "",
        "Closes #918",
      ].join("\n");
      expect(parseIssueRefs(body)).toEqual([918]);
    });

    // The other incident: a body asking a human to close an issue by hand.
    // Backticks are the documented escape hatch for this shape.
    it("respects backticks as the escape hatch for meta-discussion", () => {
      expect(parseIssueRefs("Please `close #919` manually once the release ships.")).toEqual([]);
    });
  });
});
