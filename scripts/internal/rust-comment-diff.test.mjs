import { describe, it, expect } from "vitest";
import {
  lineStartsInCode,
  commentOnlyLines,
  changedLineNumbers,
  isCommentOnlyChange,
} from "./rust-comment-diff.mjs";

/** A -U0 diff header replacing old line `o` with new line `n` (one line each). */
const oneLineDiff = (o, n = o) =>
  [
    "diff --git a/x.rs b/x.rs",
    "index 1..2 100644",
    "--- a/x.rs",
    "+++ b/x.rs",
    `@@ -${o} +${n} @@`,
    "-a",
    "+b",
  ].join("\n");

describe("isCommentOnlyChange (#3903)", () => {
  const base = [
    "//! Module docs.",
    "",
    "/// Adds one.",
    "fn add(x: u32) -> u32 {",
    "    x + 1",
    "}",
  ].join("\n");

  it("counts a doc-comment-only edit as docs", () => {
    const next = base.replace("/// Adds one.", "/// Adds one to `x`.");
    expect(isCommentOnlyChange(base, next, oneLineDiff(3))).toBe(true);
    const inner = base.replace("//! Module docs.", "//! Better module docs.");
    expect(isCommentOnlyChange(base, inner, oneLineDiff(1))).toBe(true);
  });

  it("counts an added plain // comment line as docs", () => {
    const next = base.replace("    x + 1", "    // Overflow is fine here.\n    x + 1");
    const diff = "--- a/x.rs\n+++ b/x.rs\n@@ -4,0 +5 @@\n+    // Overflow is fine here.";
    expect(isCommentOnlyChange(base, next, diff)).toBe(true);
  });

  it("treats a mixed comment + code diff as code", () => {
    const next = base.replace("/// Adds one.", "/// Adds two.").replace("x + 1", "x + 2");
    const diff = "--- a/x.rs\n+++ b/x.rs\n@@ -3 +3 @@\n-a\n+b\n@@ -5 +5 @@\n-a\n+b";
    expect(isCommentOnlyChange(base, next, diff)).toBe(false);
  });

  it("treats a code line with a trailing comment as code", () => {
    const old = base.replace("    x + 1", "    x + 1 // add");
    const next = base.replace("    x + 1", "    x + 1 // add one");
    expect(isCommentOnlyChange(old, next, oneLineDiff(5))).toBe(false);
  });

  it("treats a // line inside a string literal as code", () => {
    const src = (t) => `const S: &str = "first\n// ${t}\nlast";\n`;
    expect(isCommentOnlyChange(src("a"), src("b"), oneLineDiff(2))).toBe(false);
    const raw = (t) => `const S: &str = r#"first\n// ${t} "quoted"\n"#;\n`;
    expect(isCommentOnlyChange(raw("a"), raw("b"), oneLineDiff(2))).toBe(false);
  });

  it("treats a // line inside a block comment as a comment only in code context", () => {
    const src = (t) => `/* outer /* nested */\n// ${t}\n*/\nfn f() {}\n`;
    expect(isCommentOnlyChange(src("a"), src("b"), oneLineDiff(2))).toBe(false);
  });

  it("treats a doctest line (inside a fenced doc block) as code", () => {
    const src = (t) =>
      ["/// Example:", "/// ```", `/// assert_eq!(add(${t}), 2);`, "/// ```", "fn add() {}"].join(
        "\n"
      );
    expect(isCommentOnlyChange(src("1"), src("2"), oneLineDiff(3))).toBe(false);
    // The prose after the closed fence is docs again.
    const after = (t) => `${src("1")}\n/// ${t}\nfn g() {}`;
    expect(isCommentOnlyChange(after("a"), after("b"), oneLineDiff(6))).toBe(true);
  });

  it("treats a file using ts-rs as code (docs flow into generated TS)", () => {
    const src = (t) => `/// ${t}\n#[cfg_attr(test, derive(ts_rs::TS))]\npub struct S;\n`;
    expect(isCommentOnlyChange(src("a"), src("b"), oneLineDiff(1))).toBe(false);
  });

  it("fails open on added/deleted files and unparseable diffs", () => {
    expect(isCommentOnlyChange(base, base, "new file mode 100644\n@@ -0,0 +1 @@")).toBe(false);
    expect(isCommentOnlyChange(base, base, "")).toBe(false);
    expect(isCommentOnlyChange(base, base, "@@ garbage @@")).toBe(false);
    expect(isCommentOnlyChange(undefined, base, oneLineDiff(3))).toBe(false);
  });

  it("treats a removed blank line as code (only comment lines narrow)", () => {
    const next = base.replace("\n\n", "\n");
    const diff = "--- a/x.rs\n+++ b/x.rs\n@@ -2 +1,0 @@\n-";
    expect(isCommentOnlyChange(base, next, diff)).toBe(false);
  });
});

describe("lineStartsInCode", () => {
  it("does not mistake char literals or lifetimes for string starts", () => {
    const src = [`let q = '"';`, `fn f<'a>(x: &'a str) {}`, "// c", `let e = '\\'';`, "// d"].join(
      "\n"
    );
    expect(lineStartsInCode(src)).toEqual([true, true, true, true, true]);
    expect(commentOnlyLines(src)).toEqual([false, false, true, false, true]);
  });

  it("tracks multi-line strings and raw strings", () => {
    const src = ['let s = "a', "b", '";', 'let r = br##"x', '"# still', '"##;', "x"].join("\n");
    expect(lineStartsInCode(src)).toEqual([true, false, false, true, false, false, true]);
  });

  it("does not treat raw identifiers as raw strings", () => {
    expect(lineStartsInCode("let r#type = 1;\n// c")).toEqual([true, true]);
  });
});

describe("changedLineNumbers", () => {
  it("expands hunk ranges, defaulting a missing count to 1", () => {
    expect(changedLineNumbers("@@ -3,2 +3 @@\n@@ -10,0 +9,2 @@")).toEqual({
      removed: [3, 4],
      added: [3, 9, 10],
    });
  });
});
