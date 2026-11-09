import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  WATCHED,
  changedLines,
  enclosingHeadings,
  findTriggers,
  reviewNote,
} from "./check-security-claim-trigger.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ARCH = [
  "## 9. Architecture Decisions", // 1
  "### ADR-1: React over Svelte", // 2
  "React text.", // 3
  "### ADR-19: Native plugins run out of process", // 4
  "#### Consequences", // 5
  "Sandbox text.", // 6
  "## 10. Quality Requirements", // 7
  "Quality text.", // 8
].join("\n");

const diffAt = (start, count) => `diff --git a/x b/x\n@@ -1,1 +${start},${count} @@\n+x\n`;

describe("changedLines", () => {
  it("expands hunks and maps a pure deletion to the line it follows", () => {
    expect(changedLines("@@ -3,2 +3,2 @@\n@@ -9 +9 @@\n@@ -12,3 +11,0 @@")).toEqual([3, 4, 9, 11]);
  });
});

describe("enclosingHeadings", () => {
  it("finds the section at the given level, ignoring deeper headings", () => {
    expect(enclosingHeadings(ARCH, [6], 3)).toEqual(
      new Set(["ADR-19: Native plugins run out of process"])
    );
    expect(enclosingHeadings(ARCH, [3, 8], 3)).toEqual(
      new Set(["ADR-1: React over Svelte", "10. Quality Requirements"])
    );
  });
});

describe("findTriggers + reviewNote", () => {
  const content = {
    "docs/architecture.md": ARCH,
    "SECURITY.md": "# Policy\n## Native Plugin Sandbox\nx\n",
  };
  const run = (files, diffs) =>
    findTriggers(
      files,
      (f) => diffs[f],
      (f) => content[f]
    );

  it("flags a plugin ADR change without a README change", () => {
    const result = run(["docs/architecture.md"], { "docs/architecture.md": diffAt(6, 1) });
    expect(result.sections).toEqual([
      "docs/architecture.md → ADR-19: Native plugins run out of process",
    ]);
    expect(reviewNote(result)).toMatch(
      /Plugin security sections changed without a README\.md change/
    );
  });

  it("flags a SECURITY.md plugin section", () => {
    const result = run(["SECURITY.md"], { "SECURITY.md": diffAt(3, 1) });
    expect(result.sections).toEqual(["SECURITY.md → Native Plugin Sandbox"]);
  });

  it("stays quiet for an unrelated ADR or when README.md changed too", () => {
    expect(
      reviewNote(run(["docs/architecture.md"], { "docs/architecture.md": diffAt(3, 1) }))
    ).toBeNull();
    const both = run(["docs/architecture.md", "README.md"], {
      "docs/architecture.md": diffAt(6, 1),
    });
    expect(both.sections).toHaveLength(1);
    expect(reviewNote(both)).toBeNull();
  });
});

describe("real repository", () => {
  it("the watched files carry plugin sections the rules can find", () => {
    for (const [file, { level, matches }] of Object.entries(WATCHED)) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      const all = text.split("\n").map((_, i) => i + 1);
      const hits = [...enclosingHeadings(text, all, level)].filter(matches);
      expect(hits.length, file).toBeGreaterThan(0);
    }
  });
});
