import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import {
  parsePins,
  findInstallSteps,
  findProblems,
  loadRepo,
  PIN_FILE,
} from "./check-cargo-tool-pins.mjs";

const SHA = "fa23953489c080190314742a9b907f8e97c6767c";
const PINS = JSON.stringify({
  $comment: "x",
  tools: { "cargo-deny": "0.20.2", "cargo-audit": "0.22.2" },
});

/** One workflow job whose steps install `tools` (one install step per entry). */
function workflow(...tools) {
  const steps = tools.map(
    (tool) =>
      `      - name: Install\n        uses: taiki-e/install-action@${SHA} # v2.87.10\n` +
      `        with:\n          tool: ${tool}\n`
  );
  return `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v6\n${steps.join("")}`;
}

/** A consistent repo view; tests override one field at a time. */
function repo(overrides = {}) {
  return {
    pinFile: PINS,
    files: {
      ".github/workflows/security-audit.yml": workflow("cargo-audit@0.22.2", "cargo-deny@0.20.2"),
      ".github/workflows/release.yml": workflow("cargo-audit@0.22.2,cargo-deny@0.20.2"),
    },
    ...overrides,
  };
}

describe("parsePins", () => {
  it("reads the tools map", () => {
    expect(parsePins(PINS)).toEqual({
      pins: { "cargo-deny": "0.20.2", "cargo-audit": "0.22.2" },
      problems: [],
    });
  });

  it("rejects a missing file, bad JSON, a missing tools map, or an inexact version", () => {
    expect(parsePins(null).pins).toBeNull();
    expect(parsePins("{").problems[0]).toMatch(/not valid JSON/);
    expect(parsePins("{}").problems[0]).toMatch(/"tools" object/);
    expect(parsePins('{"tools":{"cargo-deny":"0.20"}}').problems[0]).toMatch(/exact X\.Y\.Z/);
    expect(parsePins('{"tools":{"cargo-deny":"^0.20.2"}}').problems).toHaveLength(1);
  });
});

describe("findInstallSteps", () => {
  it("finds each install step with its line, ref and tool value", () => {
    const steps = findInstallSteps(workflow("cargo-audit@0.22.2", "cargo-deny"));
    expect(steps).toEqual([
      { line: 6, ref: SHA, tool: "cargo-audit@0.22.2" },
      { line: 10, ref: SHA, tool: "cargo-deny" },
    ]);
  });

  it("handles `- uses:` as the list item, quoting and trailing comments", () => {
    const text = `    steps:\n      - uses: "taiki-e/install-action@${SHA}"\n        with:\n          tool: 'cargo-deny@0.20.2' # pinned\n`;
    expect(findInstallSteps(text)).toEqual([{ line: 2, ref: SHA, tool: "cargo-deny@0.20.2" }]);
  });

  it("does not borrow the next step's tool when a step has none", () => {
    const text =
      `    steps:\n      - uses: taiki-e/install-action@${SHA}\n` +
      `      - uses: other/action@${SHA}\n        with:\n          tool: cargo-deny@0.20.2\n`;
    expect(findInstallSteps(text)).toEqual([{ line: 2, ref: SHA, tool: null }]);
  });

  it("works with CRLF line endings", () => {
    expect(findInstallSteps(workflow("cargo-deny@0.20.2").replaceAll("\n", "\r\n"))).toHaveLength(
      1
    );
  });
});

describe("findProblems", () => {
  it("passes a consistent repo", () => {
    expect(findProblems(repo())).toEqual([]);
  });

  it("fails on an unpinned tool", () => {
    const problems = findProblems(
      repo({ files: { "w.yml": workflow("cargo-audit@0.22.2", "cargo-deny") } })
    );
    expect(problems).toEqual([expect.stringMatching(/^w\.yml:10: "cargo-deny" is unpinned/)]);
  });

  it("fails on an unpinned tool inside a comma-separated list", () => {
    const problems = findProblems(
      repo({ files: { "w.yml": workflow("cargo-audit@0.22.2, cargo-deny") } })
    );
    expect(problems).toEqual([expect.stringMatching(/"cargo-deny" is unpinned/)]);
  });

  it("fails on a non-exact version such as @latest or @0.20", () => {
    for (const tool of ["cargo-deny@latest", "cargo-deny@0.20"]) {
      const problems = findProblems(
        repo({ files: { "w.yml": workflow("cargo-audit@0.22.2", tool) } })
      );
      expect(problems).toEqual([expect.stringMatching(/is unpinned/)]);
    }
  });

  it("fails when a version differs from the pin file (gate drift)", () => {
    const files = { ...repo().files, "s.yml": workflow("cargo-deny@0.20.1") };
    expect(findProblems(repo({ files }))).toEqual([
      expect.stringMatching(/^s\.yml:6: cargo-deny@0\.20\.1 differs from cargo-deny@0\.20\.2/),
    ]);
  });

  it("fails on a tool with no pin and on a stale pin", () => {
    const problems = findProblems(
      repo({ files: { "w.yml": workflow("cargo-audit@0.22.2", "cargo-fuzz@0.13.2") } })
    );
    expect(problems).toEqual([
      expect.stringMatching(/cargo-fuzz has no pin in/),
      `${PIN_FILE}: cargo-deny is installed by no workflow — remove the stale pin`,
    ]);
  });

  it("fails on a missing or expression tool input and on a shorthand ref", () => {
    const files = {
      "a.yml": `    steps:\n      - uses: taiki-e/install-action@${SHA}\n`,
      "b.yml": workflow("${{ matrix.tool }}"),
      "c.yml": `    steps:\n      - uses: taiki-e/install-action@cargo-deny\n`,
    };
    const problems = findProblems(repo({ files: { ...repo().files, ...files } }));
    expect(problems).toEqual([
      expect.stringMatching(/^a\.yml:2: .*literal/),
      expect.stringMatching(/^b\.yml:6: .*literal/),
      expect.stringMatching(/^c\.yml:2: taiki-e\/install-action@cargo-deny/),
    ]);
  });

  it("reports a broken pin file", () => {
    expect(findProblems(repo({ pinFile: null }))).toEqual([`${PIN_FILE} not found`]);
  });
});

describe("the real repository", () => {
  it("pins every install-action tool to the version in the pin file", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const real = loadRepo(root);
    expect(Object.keys(real.files).length).toBeGreaterThan(0);
    expect(findProblems(real)).toEqual([]);
  });
});
