/**
 * Style contract for the OSC 133 command-mark gutter bar (#5563, #5640).
 *
 * The product-run UI review found the marks were 2px slivers painted at 75%
 * opacity (the failure red fell to ~3.7:1) and that their exit-code tooltip
 * could never show because the bar ignored the pointer (#5563). A later review
 * (#5640) found the bar touched the prompt text and that success and failure
 * differed only by hue, which red-green colour-blind users cannot tell apart.
 * The next review (#5854 R-078) found 3px bars still too thin to see and hover,
 * and the dashed failure bar looking like the solid one at a normal distance.
 * jsdom does not lay out or cascade, so this pins the stylesheet rules that
 * fix it. The colours' contrast is graded per theme in
 * `themes/themeStateContrast.test.ts`.
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
  it("is 5px wide via the shared token (#5854: 3px was too thin)", () => {
    expect(ruleBody(terminalCss, MARK)).toMatch(
      /width:\s*var\(--terminal-command-mark-width\)\s*!important/
    );
    expect(pxToken("--terminal-command-mark-width")).toBe(5);
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

  it("draws failure as a notched bar and success as a solid one (#5854, not colour alone)", () => {
    const failure = ruleBody(terminalCss, `${MARK}--failure`);
    for (const prefix of ["-webkit-mask", "mask"]) {
      const re = (prop: string) => new RegExp(`(^|[^-])${prefix}-${prop}:\\s*([^;]+);`);
      // Three opaque layers: the top block, the bottom block and the thin spine.
      const image = re("image").exec(failure)?.[2] ?? "";
      expect(image.match(/linear-gradient\(black, black\)/g)).toHaveLength(3);
      const size = re("size").exec(failure)?.[2] ?? "";
      expect(size).toMatch(/var\(--terminal-command-mark-notch-height\)/);
      expect(size).toMatch(/var\(--terminal-command-mark-spine\)\s+100%/);
      expect(re("repeat").exec(failure)?.[2]).toBe("no-repeat");
    }
    expect(ruleBody(terminalCss, `${MARK}--success`)).not.toMatch(/mask/);
  });

  it("cuts a notch that a glance can see but keeps a spine to hold the shape", () => {
    const notch = variablesCss.match(/--terminal-command-mark-notch-height:\s*(\d+)%;/);
    expect(notch).not.toBeNull();
    expect(Number(notch![1])).toBeGreaterThanOrEqual(30);
    expect(Number(notch![1])).toBeLessThanOrEqual(50);
    const spine = pxToken("--terminal-command-mark-spine");
    expect(spine).toBeGreaterThanOrEqual(1);
    // At most half the bar: the cut must be wider than what is left.
    expect(spine * 2).toBeLessThanOrEqual(pxToken("--terminal-command-mark-width"));
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

describe("command-mark hover area (#5854)", () => {
  const hit = () => ruleBody(terminalCss, `${MARK}::after`);

  it("covers the whole left padding: inset, bar and gutter", () => {
    expect(hit()).toMatch(/content:\s*"";/);
    expect(hit()).toMatch(/position:\s*absolute;/);
    expect(hit()).toMatch(/left:\s*calc\(var\(--terminal-command-mark-inset\)\s*\*\s*-1\);/);
    expect(hit()).toMatch(/right:\s*calc\(var\(--terminal-command-mark-gutter\)\s*\*\s*-1\);/);
  });

  it("is at least 24px tall (WCAG 2.2 SC 2.5.8) and centred on the prompt row", () => {
    expect(pxToken("--terminal-command-mark-hit-min-height")).toBeGreaterThanOrEqual(24);
    expect(hit()).toMatch(
      /height:\s*max\(100%,\s*var\(--terminal-command-mark-hit-min-height\)\);/
    );
    expect(hit()).toMatch(
      /top:\s*calc\(\(100%\s*-\s*max\(100%,\s*var\(--terminal-command-mark-hit-min-height\)\)\)\s*\/\s*2\);/
    );
  });

  it("is transparent: it adds hover reach, never paint", () => {
    expect(hit()).not.toMatch(/background|border|box-shadow/);
  });
});
