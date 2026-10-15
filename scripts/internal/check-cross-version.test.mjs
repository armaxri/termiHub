import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  parsePin,
  duplicatedPins,
  findProblems,
  loadRepo,
  PIN_FILE,
  WRAPPER_ACTION,
  AGENT_SCRIPT,
} from "./check-cross-version.mjs";

const SHA = "642375d1bcf3bd88272c32ba90e999f3d983050adf45e66bd2d3887e8e838bad";
const PIN = `# comment\nversion=0.2.5\nsha256=${SHA}\n`;
const DOWNLOAD =
  'url="https://github.com/cross-rs/cross/releases/download/v${CROSS_VERSION}/cross.tar.gz"';
const WRAPPER = `runs:\n  steps:\n    - run: cat "$GITHUB_ACTION_PATH/../../cross-version"\n`;
const SCRIPT = [
  `CROSS_PIN_FILE="$REPO_ROOT/${PIN_FILE}"`,
  `CROSS_VERSION="$(sed -n 's/^version=//p' "$CROSS_PIN_FILE")"`,
  DOWNLOAD,
].join("\n");

/** A consistent repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    pinFile: PIN,
    wrapperAction: WRAPPER,
    agentScript: SCRIPT,
    files: { ".github/workflows/agent.yml": "      - uses: ./.github/actions/setup-cross\n" },
    ...overrides,
  };
}

describe("parsePin", () => {
  it("reads version and sha256, ignoring comments and whitespace", () => {
    expect(parsePin(`${PIN}  \n`)).toEqual({ version: "0.2.5", sha256: SHA });
  });

  it("rejects a missing file, a partial version, or a malformed hash", () => {
    expect(parsePin(null)).toBeNull();
    expect(parsePin(`version=0.2\nsha256=${SHA}`)).toBeNull();
    expect(parsePin("version=0.2.5\nsha256=abc")).toBeNull();
    expect(parsePin(`version=0.2.5\nsha256=${SHA.toUpperCase()}`)).toBeNull();
    expect(parsePin(`sha256=${SHA}`)).toBeNull();
  });
});

describe("duplicatedPins", () => {
  it("flags release downloads and hard-coded env or shell values", () => {
    const text = [
      "env:",
      '  CROSS_VERSION: "0.2.5"',
      `  CROSS_SHA256: "${SHA}"`,
      "run: |",
      `  ${DOWNLOAD}`,
      'CROSS_VERSION="0.2.6"',
      "  - uses: ./.github/actions/setup-cross",
      "  CROSS_VERSION: ${{ steps.pin.outputs.version }}",
    ].join("\n");
    expect(duplicatedPins({ "a.yml": text })).toEqual(["a.yml:2", "a.yml:3", "a.yml:5", "a.yml:6"]);
  });

  it("with allowDownload only flags hard-coded values", () => {
    const text = `${DOWNLOAD}\nCROSS_VERSION="0.2.5"`;
    expect(duplicatedPins({ "s.sh": text }, { allowDownload: true })).toEqual(["s.sh:2"]);
  });

  it("ignores cargo install from git (the local setup path)", () => {
    const text = "cargo install cross --git https://github.com/cross-rs/cross";
    expect(duplicatedPins({ "setup.sh": text })).toEqual([]);
  });
});

describe("findProblems", () => {
  it("passes a consistent repo", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("fails on a missing or malformed pin file", () => {
    expect(findProblems(repo({ pinFile: null }))).toHaveLength(1);
    expect(findProblems(repo({ pinFile: "version=latest" }))).toHaveLength(1);
  });

  it("fails when the wrapper action is missing or stops reading the pin file", () => {
    expect(findProblems(repo({ wrapperAction: null }))).toEqual([`${WRAPPER_ACTION} not found`]);
    expect(findProblems(repo({ wrapperAction: "env:\n  CROSS_VERSION: x" }))).toHaveLength(1);
  });

  it("fails when the agent script stops reading the pin file or hard-codes it", () => {
    expect(findProblems(repo({ agentScript: null }))).toEqual([`${AGENT_SCRIPT} not found`]);
    const hardcoded = `CROSS_VERSION="0.2.5"\nCROSS_SHA256="${SHA}"\n${DOWNLOAD}`;
    const problems = findProblems(repo({ agentScript: hardcoded }));
    expect(problems).toEqual([
      `${AGENT_SCRIPT} must read the pin from ${PIN_FILE}`,
      `${AGENT_SCRIPT}:1: hard-codes a cross-rs pin — read it from ${PIN_FILE}`,
      `${AGENT_SCRIPT}:2: hard-codes a cross-rs pin — read it from ${PIN_FILE}`,
    ]);
  });

  it("fails when a workflow pins cross-rs itself (the pre-#4360 shape)", () => {
    const stray = `        env:\n          CROSS_VERSION: "0.2.5"\n        run: |\n          ${DOWNLOAD}\n`;
    const problems = findProblems(repo({ files: { ".github/workflows/x.yml": stray } }));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^\.github\/workflows\/x\.yml:2: pins or downloads cross-rs/);
  });
});

describe("the real repository", () => {
  it("is consistent", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadRepo(root))).toEqual([]);
  });
});
