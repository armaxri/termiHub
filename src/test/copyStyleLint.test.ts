// @vitest-environment node
/**
 * Copy style lint (#5391): the repo's ESLint config enforces the mechanically
 * checkable parts of docs/copy-style.md, with today's violations grandfathered
 * in scripts/internal/copy-style-baseline.json. Lints snippets through the real
 * config, as if they were a production component.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import {
  britishSpelling,
  formatMessage,
  parseMessage,
  titleCaseWords,
} from "../../scripts/internal/eslint-copy-style.mjs";
import { pruneBaseline, toBaseline } from "../../scripts/internal/copy-style-baseline.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE_PATH = `${REPO_ROOT}src/components/CopyStyleProbe.tsx`;
const PROBE_KEY = "src/components/CopyStyleProbe.tsx";

let eslint: ESLint;

/** `[check, text]` pairs the copy-style rule reports for the given source. */
async function violations(source: string, linter = eslint): Promise<[string, string][]> {
  const [result] = await linter.lintText(source, { filePath: PROBE_PATH });
  return result.messages
    .filter((m) => m.ruleId === "copy/copy-style")
    .map((m) => {
      const parsed = parseMessage(m.message);
      return [parsed?.check ?? "?", parsed?.text ?? m.message];
    });
}

/** Wrap JSX in a component so the snippet is a valid module. */
function component(jsx: string[]): string {
  return [
    'import { Button, Modal } from "@/components/ui";',
    "export function P(p: { busy: boolean; open: boolean }) {",
    "  return (",
    ...jsx,
    "  );",
    "}",
  ].join("\n");
}

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

describe("titleCaseWords", () => {
  it("flags capitalized words after the first word", () => {
    expect(titleCaseWords("Save & Connect")).toEqual(["Connect"]);
    expect(titleCaseWords("Clear History")).toEqual(["History"]);
    expect(titleCaseWords("Read-Only Mode")).toEqual(["Only", "Mode"]);
  });

  it("allows sentence case, acronyms, mixed-case names and proper nouns", () => {
    expect(titleCaseWords("Allow experimental features")).toEqual([]);
    expect(titleCaseWords("Open SSH session in termiHub")).toEqual([]);
    expect(titleCaseWords("Use PowerShell on Windows or macOS")).toEqual([]);
    expect(titleCaseWords("Press Ctrl and Shift")).toEqual([]);
  });

  it("restarts at a new sentence and skips quoted names", () => {
    expect(titleCaseWords("Saved. Reconnect to apply")).toEqual([]);
    expect(titleCaseWords("Error: Something failed")).toEqual([]);
    expect(titleCaseWords('Delete "My Server"')).toEqual([]);
  });
});

describe("britishSpelling", () => {
  it("finds British spellings and names the US form", () => {
    expect(britishSpelling("Transfer cancelled")?.us).toBe("canceled / canceling");
    expect(britishSpelling("Pick a colour")?.us).toBe("color");
    expect(britishSpelling("Initialise the store")?.us).toBe("-ize / -ization");
  });

  it("leaves US spelling and look-alikes alone", () => {
    expect(britishSpelling("Transfer canceled")).toBeNull();
    expect(britishSpelling("Pick a color")).toBeNull();
    expect(britishSpelling("Cancellation pending")).toBeNull();
    expect(britishSpelling("Raise the window, otherwise wise")).toBeNull();
  });
});

describe("message format", () => {
  it("round-trips the check and text, including quotes and dashes", () => {
    const text = 'Saved "a" — b';
    expect(parseMessage(formatMessage("sentence-case", text))).toEqual({
      check: "sentence-case",
      text,
    });
    expect(parseMessage("some other message")).toBeNull();
  });
});

describe("copy style lint (#5391)", () => {
  it("flags Title Case in button text, dialog titles and labels", async () => {
    const source = component([
      '    <Modal open={p.open} title="Unsaved Changes" onClose={() => {}}>',
      '      <Button variant="secondary">Clear History</Button>',
      '      <Button>{p.busy ? "Saving…" : "Save Now"}</Button>',
      '      <input aria-label="x" />',
      "    </Modal>",
    ]);
    const options = 'export const item = { label: "Close All Tabs" };';
    expect(await violations(`${source}\n${options}`)).toEqual([
      ["sentence-case", "Unsaved Changes"],
      ["sentence-case", "Clear History"],
      ["sentence-case", "Save Now"],
      ["sentence-case", "Close All Tabs"],
    ]);
  });

  it("flags acknowledgement and discard wording on buttons", async () => {
    const source = component([
      "    <div>",
      '      <Button variant="secondary">Dismiss</Button>',
      '      <Button variant="secondary">Just close</Button>',
      '      <Button variant="secondary">Discard changes</Button>',
      "      <Button>Close</Button>",
      "    </div>",
    ]);
    expect(await violations(source)).toEqual([
      ["acknowledgement", "Dismiss"],
      ["discard", "Just close"],
    ]);
  });

  it("flags British spelling in any user-facing text", async () => {
    const source = [
      "declare const toast: { error: (m: string) => void };",
      "export function P() {",
      '  toast.error("Transfer cancelled");',
      '  return <div title="Pick a colour">Behaviour</div>;',
      "}",
    ].join("\n");
    expect(await violations(source)).toEqual([
      ["us-spelling", "Transfer cancelled"],
      ["us-spelling", "Pick a colour"],
      ["us-spelling", "Behaviour"],
    ]);
  });

  it("flags two primary buttons and Cancel on the right in one footer", async () => {
    const source = component([
      "    <div>",
      "      <Button>Save</Button>",
      "      {p.open && (",
      "        <>",
      "          <Button>Save and connect</Button>",
      '          <Button variant="secondary">Cancel</Button>',
      "        </>",
      "      )}",
      "    </div>",
    ]);
    expect(await violations(source)).toEqual([
      ["one-primary", "Save | Save and connect"],
      ["cancel-left", "Save | Save and connect | Cancel"],
    ]);
  });

  it("accepts a footer that follows the guide", async () => {
    const source = component([
      '    <Modal open={p.open} title="Unsaved changes" onClose={() => {}}>',
      '      <Button variant="secondary">Cancel</Button>',
      '      <Button variant="secondary">Test connection</Button>',
      "      {p.busy ? <Button>Saving…</Button> : <Button>Save</Button>}",
      "      <p>Open an SSH session in termiHub. The color was canceled.</p>",
      "    </Modal>",
    ]);
    expect(await violations(source)).toEqual([]);
  });

  it("does not flag non-copy strings", async () => {
    const source = [
      "export function P() {",
      '  const mode = "Read Only";',
      '  return <div className="Big Box" data-testid="Save Now">{mode}</div>;',
      "}",
    ].join("\n");
    expect(await violations(source)).toEqual([]);
  });

  it("grandfathers baselined violations, one occurrence per count", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "copy-style-"));
    try {
      const baselinePath = path.join(dir, "baseline.json");
      const baseline = { [PROBE_KEY]: { "sentence-case": { "Clear History": 1 } } };
      writeFileSync(baselinePath, JSON.stringify(baseline));
      const linter = new ESLint({
        cwd: REPO_ROOT,
        overrideConfig: {
          files: ["src/**/*.tsx"],
          rules: { "copy/copy-style": ["error", { baselinePath }] },
        },
      });
      const source = component([
        "    <div>",
        '      <Button variant="secondary">Clear History</Button>',
        '      <Button variant="secondary">Clear History</Button>',
        "      <Button>Save Now</Button>",
        "    </div>",
      ]);
      expect(await violations(source, linter)).toEqual([
        ["sentence-case", "Clear History"],
        ["sentence-case", "Save Now"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("baseline tool", () => {
  it("counts violations per file, check and text", () => {
    expect(
      toBaseline([
        { file: "b.tsx", check: "discard", text: "Just close" },
        { file: "a.tsx", check: "sentence-case", text: "Save Now" },
        { file: "a.tsx", check: "sentence-case", text: "Save Now" },
      ])
    ).toEqual({
      "a.tsx": { "sentence-case": { "Save Now": 2 } },
      "b.tsx": { discard: { "Just close": 1 } },
    });
  });

  it("prunes fixed entries and never adds new ones", () => {
    const baseline = {
      "a.tsx": { "sentence-case": { "Save Now": 2, "Clear History": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    };
    const current = {
      "a.tsx": { "sentence-case": { "Save Now": 1, "New Thing": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    };
    const { pruned, stale } = pruneBaseline(baseline, current);
    expect(pruned).toEqual({
      "a.tsx": { "sentence-case": { "Save Now": 1 } },
      "b.tsx": { discard: { "Just close": 1 } },
    });
    expect(stale).toEqual([
      { file: "a.tsx", check: "sentence-case", text: "Save Now", count: 1 },
      { file: "a.tsx", check: "sentence-case", text: "Clear History", count: 1 },
    ]);
  });
});
