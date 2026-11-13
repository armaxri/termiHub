/**
 * Style contract for the OSC 133 command-mark gutter bar (#5563, #5640).
 *
 * The product-run UI review found the marks were 2px slivers painted at 75%
 * opacity (the failure red fell to ~3.7:1) and that their exit-code tooltip
 * could never show because the bar ignored the pointer (#5563). A later review
 * (#5640) found the bar touched the prompt text and that success and failure
 * differed only by hue, which red-green colour-blind users cannot tell apart.
 * jsdom does not lay out or cascade, so this pins the stylesheet rules that
 * fix it. The colours' contrast is graded per theme in `themes/contrast.test.ts`.
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

/** The px value of a `--name: Npx;` token in variables.css. */
function pxToken(name: string): number {
  const match = variablesCss.match(new RegExp(`${name}:\\s*(\\d+)px;`));
  expect(match, `token ${name} is a px value`).not.toBeNull();
  return Number(match![1]);
}

const MARK = ".terminal-container .xterm-decoration.terminal-command-mark";

describe("command-mark gutter bar style (#5563)", () => {
  it("is 3px wide via the shared token", () => {
    expect(ruleBody(terminalCss, MARK)).toMatch(
      /width:\s*var\(--terminal-command-mark-width\)\s*!important/
    );
    expect(pxToken("--terminal-command-mark-width")).toBe(3);
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

describe("command-mark gutter and shape (#5640)", () => {
  it("reserves a 6-8px gutter between the bar and the prompt text", () => {
    const gutter = pxToken("--terminal-command-mark-gutter");
    expect(gutter).toBeGreaterThanOrEqual(6);
    expect(gutter).toBeLessThanOrEqual(8);
    // The bar sits a full bar-plus-gutter left of the cell grid...
    expect(ruleBody(terminalCss, MARK)).toMatch(
      /left:\s*calc\(\s*\(var\(--terminal-command-mark-width\)\s*\+\s*var\(--terminal-command-mark-gutter\)\)\s*\*\s*-1\s*\)/
    );
    // ...and the .xterm left padding is wide enough to hold the inset, bar and gutter.
    expect(variablesCss).toMatch(
      /--terminal-text-inset-left:\s*calc\(\s*var\(--terminal-command-mark-inset\)\s*\+\s*var\(--terminal-command-mark-width\)\s*\+\s*var\(--terminal-command-mark-gutter\)\s*\);/
    );
    expect(ruleBody(terminalCss, ".terminal-container .xterm")).toMatch(
      /padding:\s*0\s+var\(--spacing-sm\)\s+0\s+var\(--terminal-text-inset-left\);/
    );
  });

  it("draws failure as a dashed bar and success as a solid one (not colour alone)", () => {
    const failure = ruleBody(terminalCss, `${MARK}--failure`);
    expect(failure).toMatch(/-webkit-mask-image:\s*repeating-linear-gradient\(/);
    expect(failure).toMatch(/(^|[^-])mask-image:\s*repeating-linear-gradient\(/);
    expect(failure).toMatch(/transparent/);
    expect(ruleBody(terminalCss, `${MARK}--success`)).not.toMatch(/mask/);
  });
});

describe("command marks in horizontal-scroll mode (#5693)", () => {
  // The marks are drawn inside .xterm-screen at a negative left. Horizontal
  // mode used to drop the .xterm left padding and clip .xterm-screen, which
  // cut the marks off entirely.
  it("keeps the command-mark inset and gutter as the .xterm left padding", () => {
    expect(ruleBody(terminalCss, ".terminal-horizontal-scroll .xterm")).toMatch(
      /padding:\s*0\s+0\s+calc\(var\(--hscroll-bar\)\s*\+\s*var\(--spacing-xs\)\)\s+var\(--terminal-text-inset-left\);/
    );
  });

  it("clips the wide rows at the .xterm padding box, not at the screen", () => {
    expect(ruleBody(terminalCss, ".terminal-horizontal-scroll .xterm")).toMatch(
      /overflow:\s*clip;/
    );
    expect(terminalCss).not.toMatch(/\.terminal-horizontal-scroll \.xterm-screen\s*\{/);
  });

  it("does not inset the scroll viewport on the left on top of the padding", () => {
    expect(ruleBody(terminalCss, ".terminal-scroll-viewport.terminal-horizontal-scroll")).toMatch(
      /left:\s*0;/
    );
  });
});
