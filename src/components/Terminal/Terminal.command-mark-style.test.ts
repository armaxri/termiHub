/**
 * Style contract for the OSC 133 command-mark gutter bar (#5563).
 *
 * The product-run UI review found the marks were 2px slivers painted at 75%
 * opacity (the failure red fell to ~3.7:1) and that their exit-code tooltip
 * could never show because the bar ignored the pointer. jsdom does not lay out
 * or cascade, so this pins the stylesheet rules that fix it. The colours'
 * contrast is graded per theme in `themes/contrast.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const terminalCss = readFileSync(join(SRC_DIR, "components/Terminal/Terminal.css"), "utf8");
const variablesCss = readFileSync(join(SRC_DIR, "styles/variables.css"), "utf8");

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `rule ${selector} exists`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

const MARK = ".terminal-container .xterm-decoration.terminal-command-mark";

describe("command-mark gutter bar style (#5563)", () => {
  it("is 3px wide via the shared token", () => {
    expect(ruleBody(terminalCss, MARK)).toMatch(
      /width:\s*var\(--terminal-command-mark-width\)\s*!important/
    );
    expect(variablesCss).toMatch(/--terminal-command-mark-width:\s*3px;/);
  });

  it("paints at full strength (no opacity) and takes the pointer for its tooltip", () => {
    const body = ruleBody(terminalCss, MARK);
    expect(body).not.toMatch(/opacity/);
    expect(body).not.toMatch(/pointer-events:\s*none/);
  });

  it("uses the full-strength status tokens", () => {
    expect(ruleBody(terminalCss, `${MARK}--success`)).toMatch(
      /background-color:\s*var\(--color-success\);/
    );
    expect(ruleBody(terminalCss, `${MARK}--failure`)).toMatch(
      /background-color:\s*var\(--color-error\);/
    );
  });
});
