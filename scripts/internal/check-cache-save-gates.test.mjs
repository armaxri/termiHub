import { describe, it, expect } from "vitest";
import { fileURLToPath } from "url";
import path from "path";
import { GATE, collectSteps, findProblems, isGated } from "./check-cache-save-gates.mjs";
import { loadFiles } from "./check-action-pins.mjs";

const SHA = "6323deb102c322ba6fcbdcafc7e3dddab59af2b6";

/** A workflow with one step, `body` holding its lines (indented as step keys). */
const workflow = (...body) =>
  ["jobs:", "  a:", "    steps:", "      - name: Cache", ...body.map((l) => `        ${l}`)].join(
    "\n"
  );

describe("isGated", () => {
  it("accepts the gate alone, wrapped or not", () => {
    expect(isGated(GATE)).toBe(true);
    expect(isGated(`\${{ ${GATE} }}`)).toBe(true);
    expect(isGated(`(${GATE})`)).toBe(true);
  });

  it("accepts the parenthesised gate ANDed with other conditions", () => {
    expect(isGated(`inputs.cache == 'true' && (${GATE})`)).toBe(true);
    expect(isGated(`\${{ (${GATE}) && (matrix.t == 'a' || matrix.t == 'b') }}`)).toBe(true);
  });

  it("rejects a missing gate, an ORed bypass and a negated gate", () => {
    expect(isGated(undefined)).toBe(false);
    expect(isGated("github.event_name != 'pull_request'")).toBe(false);
    expect(isGated("github.ref == 'refs/heads/develop'")).toBe(false);
    expect(isGated(`github.event_name == 'workflow_dispatch' || (${GATE})`)).toBe(false);
    expect(isGated(`!(${GATE})`)).toBe(false);
  });
});

describe("collectSteps", () => {
  it("reads step keys and with: inputs, folding block scalars", () => {
    const text = workflow(
      "if: >-",
      "  inputs.cache == 'true' &&",
      `  (${GATE})`,
      `uses: Swatinem/rust-cache@${SHA} # v2.9.2`,
      "with:",
      "  # a comment",
      "  shared-key: x",
      "  save-if: false",
      "",
      "      - run: echo next"
    );
    const [step] = collectSteps({ "a.yml": text });
    expect(step.action).toBe("Swatinem/rust-cache");
    expect(step.keys.if).toBe(`inputs.cache == 'true' && (${GATE})`);
    expect(step.inputs).toEqual({ "shared-key": "x", "save-if": "false" });
  });

  it("does not read the next step's keys", () => {
    const text = [
      "steps:",
      `  - uses: Swatinem/rust-cache@${SHA} # v2.9.2`,
      "  - name: next",
      "    with:",
      "      save-if: false",
    ].join("\n");
    expect(collectSteps({ "a.yml": text })[0].inputs).toEqual({});
  });
});

describe("findProblems", () => {
  it("passes gated or disabled saves and restore-only steps", () => {
    const files = {
      "a.yml": workflow(
        `uses: Swatinem/rust-cache@${SHA} # v2.9.2`,
        "with:",
        `  save-if: \${{ ${GATE} }}`
      ),
      "b.yml": workflow(`uses: Swatinem/rust-cache@${SHA} # v2.9.2`, "with:", "  save-if: false"),
      "c.yml": workflow(`if: ${GATE}`, `uses: actions/cache/save@${SHA} # v6.1.0`),
      "d.yml": workflow(`uses: actions/cache/restore@${SHA} # v6.1.0`),
      "e.yml": workflow(
        `uses: actions/setup-node@${SHA} # v6.5.0`,
        "with:",
        "  node-version: '22'"
      ),
      "f.yml": workflow(
        `uses: astral-sh/setup-uv@${SHA} # v6.8.0`,
        "with:",
        `  save-cache: \${{ ${GATE} }}`
      ),
    };
    expect(findProblems(files)).toEqual([]);
  });

  it("fails on rust-cache without save-if (the #5328 feature-branch caches)", () => {
    const problems = findProblems({
      "a.yml": workflow(`uses: Swatinem/rust-cache@${SHA} # v2.9.2`),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^a\.yml:5: Swatinem\/rust-cache saves on every ref/);
  });

  it("fails on a pull_request-only gate, which a branch dispatch slips past", () => {
    const text = workflow(
      `uses: Swatinem/rust-cache@${SHA} # v2.9.2`,
      "with:",
      "  save-if: ${{ github.event_name != 'pull_request' }}"
    );
    expect(findProblems({ "a.yml": text })).toHaveLength(1);
  });

  it("fails on ungated actions/cache, actions/cache/save and setup-uv", () => {
    const problems = findProblems({
      "a.yml": workflow(`uses: actions/cache@${SHA} # v6.1.0`),
      "b.yml": workflow(`uses: actions/cache/save@${SHA} # v6.1.0`),
      "c.yml": workflow(
        `uses: astral-sh/setup-uv@${SHA} # v6.8.0`,
        "with:",
        "  enable-cache: true"
      ),
    });
    expect(problems.map((p) => p.split(":")[0])).toEqual(["a.yml", "b.yml", "c.yml"]);
  });

  it("fails on setup-node's own cache: input", () => {
    const text = workflow(`uses: actions/setup-node@${SHA} # v6.5.0`, "with:", "  cache: 'pnpm'");
    expect(findProblems({ "a.yml": text })[0]).toMatch(/setup-node's cache: saves on every ref/);
  });
});

describe("the real repository", () => {
  it("gates every cache save to develop/main", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(findProblems(loadFiles(root))).toEqual([]);
  });
});
