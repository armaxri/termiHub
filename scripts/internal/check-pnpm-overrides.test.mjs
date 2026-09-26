import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  documentedOverrides,
  parseOverrideKey,
  lockedPackages,
  findProblems,
  loadRepo,
} from "./check-pnpm-overrides.mjs";

const DOC = [
  "# npm supply chain",
  "",
  "## Override register",
  "",
  "| Override | Pin | Parent | Advisory | Removal condition |",
  "| --- | --- | --- | --- | --- |",
  "| `dompurify` | `>=3.4.12 <4` | monaco-editor | GHSA-x | parent bumps |",
  "| `minimatch@3>brace-expansion` | `1.1.14` | minimatch 3 | GHSA-y | parent bumps |",
  "",
  "Removed: `serialize-javascript` — prose mentions are not rows.",
  "",
  "## Audit gates",
  "| `not-a-row` | x |",
].join("\n");

const LOCK = [
  "lockfileVersion: '9.0'",
  "",
  "overrides:",
  "  dompurify: '>=3.4.12 <4'",
  "",
  "packages:",
  "",
  "  '@babel/core@7.29.0':",
  "    resolution: {integrity: sha512-x}",
  "",
  "  brace-expansion@1.1.14:",
  "    resolution: {integrity: sha512-x}",
  "",
  "  dompurify@3.4.12:",
  "    resolution: {integrity: sha512-x}",
  "",
  "  minimatch@3.1.5:",
  "    resolution: {integrity: sha512-x}",
  "",
  "snapshots:",
  "",
  "  anymatch@3.1.3:",
  "    dependencies: {}",
].join("\n");

/** A consistent repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    overrides: { dompurify: ">=3.4.12 <4", "minimatch@3>brace-expansion": "1.1.14" },
    registerDoc: DOC,
    lockfile: LOCK,
    ...overrides,
  };
}

describe("documentedOverrides", () => {
  it("reads only table rows inside the register section", () => {
    expect(documentedOverrides(DOC)).toEqual(["dompurify", "minimatch@3>brace-expansion"]);
  });

  it("returns null when the section is missing", () => {
    expect(documentedOverrides("# nothing here\n")).toBeNull();
  });
});

describe("parseOverrideKey", () => {
  it("handles plain, parent-scoped and major-scoped keys", () => {
    expect(parseOverrideKey("dompurify")).toEqual({ target: "dompurify", parent: null });
    expect(parseOverrideKey("vite>picomatch")).toEqual({
      target: "picomatch",
      parent: { name: "vite", major: null },
    });
    expect(parseOverrideKey("minimatch@3>brace-expansion")).toEqual({
      target: "brace-expansion",
      parent: { name: "minimatch", major: "3" },
    });
  });
});

describe("lockedPackages", () => {
  it("lists packages-section ids, including scoped names, and ignores snapshots", () => {
    expect(lockedPackages(LOCK)).toEqual([
      { name: "@babel/core", version: "7.29.0" },
      { name: "brace-expansion", version: "1.1.14" },
      { name: "dompurify", version: "3.4.12" },
      { name: "minimatch", version: "3.1.5" },
    ]);
  });
});

describe("findProblems", () => {
  it("passes a consistent repo", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("fails on an undocumented override", () => {
    const problems = findProblems(
      repo({ overrides: { ...repo().overrides, "@babel/core": ">=7.29.1" } })
    );
    expect(problems).toEqual([
      'override "@babel/core" has no row in docs/supply-chain.md — add its advisory and removal condition',
    ]);
  });

  it("fails on a documented override that package.json no longer has", () => {
    const problems = findProblems(repo({ overrides: { dompurify: ">=3.4.12 <4" } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/documents "minimatch@3>brace-expansion"/);
  });

  it("fails on a dead override whose target left the tree", () => {
    const lockfile = LOCK.replace("  dompurify@3.4.12:\n", "  other@1.0.0:\n");
    expect(findProblems(repo({ lockfile }))).toEqual([
      'override "dompurify" is dead: dompurify is not in pnpm-lock.yaml — remove it',
    ]);
  });

  it("fails on a dead scoped override whose parent major left the tree", () => {
    const lockfile = LOCK.replace("minimatch@3.1.5", "minimatch@10.2.5");
    expect(findProblems(repo({ lockfile }))).toEqual([
      'override "minimatch@3>brace-expansion" is dead: no minimatch@3 in pnpm-lock.yaml — remove it',
    ]);
  });

  it("fails when the register section is missing", () => {
    expect(findProblems(repo({ registerDoc: "# x\n" }))).toHaveLength(1);
  });
});

describe("the real repository", () => {
  it("is consistent", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadRepo(root))).toEqual([]);
  });
});
