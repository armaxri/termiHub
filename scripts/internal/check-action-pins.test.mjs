import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { collectPins, findProblems, loadFiles } from "./check-action-pins.mjs";

const V7 = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const V4 = "ea165f8d65b6e75b540449e92b4886f43607fa02";

describe("collectPins", () => {
  it("reads list and mapping form, quoted or not, and skips local/docker uses", () => {
    const text = [
      "steps:",
      `  - uses: actions/upload-artifact@${V7} # v7.0.1`,
      "  - name: x",
      `    uses: 'actions/checkout@${V4}'`,
      "  - uses: ./.github/actions/setup-rust",
      "  - uses: docker://alpine:3.20",
      "  # uses: in a comment is not a step",
    ].join("\n");
    expect(collectPins({ "a.yml": text })).toEqual([
      { action: "actions/upload-artifact", ref: V7, comment: "v7.0.1", where: "a.yml:2" },
      { action: "actions/checkout", ref: V4, comment: "", where: "a.yml:4" },
    ]);
  });
});

describe("findProblems", () => {
  it("passes one SHA per action, each with a version comment", () => {
    const text = `- uses: actions/upload-artifact@${V7} # v7.0.1\n`;
    expect(findProblems({ "a.yml": text, "b.yml": text })).toEqual([]);
  });

  it("fails when one action is pinned to two SHAs (the pre-#4360 drift)", () => {
    const problems = findProblems({
      "a.yml": `- uses: actions/upload-artifact@${V7} # v7.0.1\n`,
      "b.yml": `- uses: actions/upload-artifact@${V4} # v4.6.2\n`,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^actions\/upload-artifact is pinned to 2 different SHAs/);
    expect(problems[0]).toContain("b.yml:1 (v4.6.2)");
  });

  it("fails on a tag, branch or short-SHA pin", () => {
    const text = [
      "- uses: actions/checkout@v6 # v6",
      "- uses: dtolnay/rust-toolchain@stable",
      "- uses: actions/cache@55cc834 # v6.1.0",
    ].join("\n");
    expect(findProblems({ "a.yml": text })).toEqual([
      "a.yml:1: actions/checkout@v6 is not pinned to a full commit SHA",
      "a.yml:2: dtolnay/rust-toolchain@stable is not pinned to a full commit SHA",
      "a.yml:3: actions/cache@55cc834 is not pinned to a full commit SHA",
    ]);
  });

  it("fails on a SHA pin without a version comment", () => {
    expect(findProblems({ "a.yml": `- uses: actions/checkout@${V4}\n` })).toEqual([
      `a.yml:1: actions/checkout@${V4} needs a "# vX.Y.Z" version comment`,
    ]);
  });
});

describe("the real repository", () => {
  it("pins every action to one commit SHA", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadFiles(root))).toEqual([]);
  });
});
