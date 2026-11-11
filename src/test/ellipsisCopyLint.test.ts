// @vitest-environment node
/**
 * Ellipsis copy lint (#5379): the repo's ESLint config rejects three dots
 * "..." in user-facing text and leaves spread syntax, comments, class names
 * and other non-copy strings alone. Lints snippets through the real config,
 * as if they were a production component.
 */
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROBE_PATH = `${REPO_ROOT}src/components/EllipsisProbe.tsx`;
const RULE_HINT = "#5379";

let eslint: ESLint;

/** Lines (1-based) reported by the ellipsis policy for the given source. */
async function flaggedLines(source: string): Promise<number[]> {
  const [result] = await eslint.lintText(source, { filePath: PROBE_PATH });
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax" && m.message.includes(RULE_HINT))
    .map((m) => m.line);
}

beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

describe("ellipsis copy lint (#5379)", () => {
  it("flags three dots in JSX text and user-facing attributes", async () => {
    const source = [
      "export function P(p: { n: string }) {",
      "  return (",
      '    <div title="Loading..." className="a...b">',
      "      Saving...",
      '      <input placeholder={p.n ? `Find ${p.n}...` : "x"} aria-label="Search..." />',
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(await flaggedLines(source)).toEqual([3, 3, 5, 5]);
  });

  it("flags label/title object keys and toast messages", async () => {
    const source = [
      "declare const toast: ((m: string) => void) & { error: (m: string) => void };",
      'export const item = { label: "Open...", id: "a...b" };',
      "export const dialog = { title: `Save to...` };",
      'toast("Working...");',
      'toast.error("Failed...");',
    ].join("\n");
    expect(await flaggedLines(source)).toEqual([2, 3, 4, 5]);
  });

  it("does not flag spread syntax, comments, the ellipsis character or other strings", async () => {
    const source = [
      "// Loading... (a comment)",
      "export function P(p: { a: Record<string, string> }) {",
      "  const merged = { ...p.a };",
      '  const notCopy = "a...b";',
      "  return (",
      '    <div className="x...y" title="Loading…" {...merged}>',
      "      Saving… {notCopy}",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(await flaggedLines(source)).toEqual([]);
  });
});
