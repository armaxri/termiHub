import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  parsePin,
  duplicatedPins,
  unpinnedInstalls,
  findProblems,
  loadRepo,
  PIN_FILE,
  WRAPPER_ACTION,
  AGENT_SCRIPT,
  SETUP_SCRIPTS,
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

const [SETUP_SH, SETUP_CMD] = SETUP_SCRIPTS;
const SETUP_SH_TEXT = [
  `CROSS_PIN_FILE="$REPO_ROOT/${PIN_FILE}"`,
  DOWNLOAD,
  'cargo install cross --locked --git "$CROSS_GIT_URL" --tag "v$CROSS_VERSION"',
].join("\n");
const SETUP_CMD_TEXT = [
  "set CROSS_PIN_FILE=.github\\cross-version",
  "    cargo install cross --locked --git %CROSS_GIT_URL% --tag v%CROSS_VERSION%",
].join("\r\n");

/** A consistent repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    pinFile: PIN,
    wrapperAction: WRAPPER,
    agentScript: SCRIPT,
    setupScripts: { [SETUP_SH]: SETUP_SH_TEXT, [SETUP_CMD]: SETUP_CMD_TEXT },
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

  it("ignores cargo install (unpinnedInstalls covers it)", () => {
    const text = "cargo install cross --git https://github.com/cross-rs/cross";
    expect(duplicatedPins({ "setup.sh": text })).toEqual([]);
  });
});

describe("unpinnedInstalls", () => {
  it("flags cargo install cross from git HEAD or crates.io latest", () => {
    const text = [
      "cargo install cross --git https://github.com/cross-rs/cross",
      "    cargo install cross",
      "cargo install --locked cross --git %CROSS_GIT_URL%",
    ].join("\n");
    expect(unpinnedInstalls({ "s.sh": text })).toEqual(["s.sh:1", "s.sh:2", "s.sh:3"]);
  });

  it("accepts installs pinned by --tag, --rev or --version, and other crates", () => {
    const text = [
      'cargo install cross --locked --git "$URL" --tag "v$CROSS_VERSION"',
      "cargo install cross --git https://github.com/cross-rs/cross --rev 588b3c9",
      "cargo install cross --locked --version 0.2.5",
      "cargo install cross-util",
      "cargo install cargo-cross-thing",
      "echo Installing cross via cargo...",
    ].join("\n");
    expect(unpinnedInstalls({ "s.sh": text })).toEqual([]);
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

  it("fails when a setup script is missing, stops reading the pin, or installs unpinned", () => {
    const missing = findProblems(repo({ setupScripts: { [SETUP_SH]: null } }));
    expect(missing).toEqual([`${SETUP_SH} not found`]);
    const unpinned = "cargo install cross --git https://github.com/cross-rs/cross";
    const problems = findProblems(repo({ setupScripts: { [SETUP_CMD]: unpinned } }));
    expect(problems).toEqual([
      `${SETUP_CMD} must read the pin from ${PIN_FILE}`,
      `${SETUP_CMD}:1: installs cross-rs unpinned — pass --tag v<version> from ${PIN_FILE}`,
    ]);
  });

  it("allows a setup script to download the pinned release but not hard-code it", () => {
    const hardcoded = `${SETUP_SH_TEXT}\nCROSS_VERSION="0.2.5"`;
    expect(findProblems(repo({ setupScripts: { [SETUP_SH]: hardcoded } }))).toEqual([
      `${SETUP_SH}:4: hard-codes a cross-rs pin — read it from ${PIN_FILE}`,
    ]);
  });

  it("fails when any other script installs cross-rs unpinned (the pre-#4731 shape)", () => {
    const stray = "cargo install cross --git https://github.com/cross-rs/cross\n";
    const problems = findProblems(repo({ files: { "scripts/other.sh": stray } }));
    expect(problems).toEqual([
      `scripts/other.sh:1: installs cross-rs unpinned — pin it to the version in ${PIN_FILE}`,
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

  it("checks both setup scripts as pin readers, not as stray files", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const loaded = loadRepo(root);
    for (const rel of SETUP_SCRIPTS) {
      expect(loaded.setupScripts[rel]).toEqual(expect.any(String));
      expect(loaded.files[rel]).toBeUndefined();
    }
  });
});
