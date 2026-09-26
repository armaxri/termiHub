import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  parsePinnedVersion,
  directSetupUvUses,
  findProblems,
  loadRepo,
  WRAPPER_ACTION,
} from "./check-uv-version.mjs";

const WRAPPER = [
  "runs:",
  "  steps:",
  '    - run: cat "$GITHUB_ACTION_PATH/../../uv-version"',
  "    - uses: astral-sh/setup-uv@abc # v6.8.0",
].join("\n");

/** A consistent repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    pinnedFile: "0.11.29\n",
    wrapperAction: WRAPPER,
    files: { ".github/workflows/ci.yml": "      - uses: ./.github/actions/setup-uv\n" },
    ...overrides,
  };
}

describe("parsePinnedVersion", () => {
  it("accepts an exact X.Y.Z version with surrounding whitespace", () => {
    expect(parsePinnedVersion("0.11.29\n")).toBe("0.11.29");
  });

  it("rejects 'latest', partial versions and missing files", () => {
    expect(parsePinnedVersion("latest")).toBeNull();
    expect(parsePinnedVersion("0.11")).toBeNull();
    expect(parsePinnedVersion(null)).toBeNull();
  });
});

describe("directSetupUvUses", () => {
  it("finds direct uses in both list and mapping form, quoted or not", () => {
    const text = [
      "steps:",
      "  - uses: astral-sh/setup-uv@abc # v6.8.0",
      "  - name: x",
      "    uses: 'astral-sh/setup-uv@v6'",
      "  - uses: ./.github/actions/setup-uv",
    ].join("\n");
    expect(directSetupUvUses({ "a.yml": text })).toEqual(["a.yml:2", "a.yml:4"]);
  });
});

describe("findProblems", () => {
  it("passes a consistent repo", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("fails on a malformed or missing pin file", () => {
    expect(findProblems(repo({ pinnedFile: "latest" }))).toHaveLength(1);
    expect(findProblems(repo({ pinnedFile: null }))).toHaveLength(1);
  });

  it("fails when the wrapper action is missing or stops reading the pin file", () => {
    expect(findProblems(repo({ wrapperAction: null }))).toEqual([`${WRAPPER_ACTION} not found`]);
    expect(
      findProblems(repo({ wrapperAction: "uses: astral-sh/setup-uv@abc\n  version: 0.11.29" }))
    ).toHaveLength(1);
  });

  it("fails on a stray direct setup-uv pin in a workflow", () => {
    const stray =
      "      - uses: astral-sh/setup-uv@abc\n        with:\n          version: '0.9.0'\n";
    const problems = findProblems(repo({ files: { ".github/workflows/x.yml": stray } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^\.github\/workflows\/x\.yml:1: uses astral-sh\/setup-uv/);
  });
});

describe("the real repository", () => {
  it("is consistent", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadRepo(root))).toEqual([]);
  });
});
