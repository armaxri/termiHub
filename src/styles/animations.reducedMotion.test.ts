/**
 * #4039: under `prefers-reduced-motion: reduce`, essential progress spinners
 * (`.motion-essential-spinner`) must render as a **static** icon — no rotation
 * and no opacity pulse (the earlier `essential-spinner-pulse` read as
 * blinking). Components put a steady text label beside the spinner instead.
 * jsdom does not evaluate media queries or animations, so this pins the CSS
 * contract at the source level.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const STYLES_DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(STYLES_DIR, "animations.css"), "utf8");

/** Strip block comments so prose about the old pulse does not count. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Return the body of the `@media (prefers-reduced-motion: reduce)` block. */
function reducedMotionBlock(source: string): string {
  const start = source.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unterminated reduced-motion block");
}

/** Return the declarations of `selector { … }` inside `source`. */
function ruleBody(source: string, selector: string): string {
  const m = source.match(new RegExp(`${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`));
  expect(m, `rule for ${selector}`).not.toBeNull();
  return m![1];
}

describe("reduced-motion essential spinner (#4039)", () => {
  const block = reducedMotionBlock(code);

  it("renders essential spinners static: animation removed outright", () => {
    const body = ruleBody(block, ".motion-essential-spinner");
    expect(body).toMatch(/animation:\s*none\s*!important/);
    expect(body).not.toMatch(/infinite/);
  });

  it("no longer defines or uses an opacity pulse", () => {
    expect(code).not.toMatch(/essential-spinner-pulse/);
    expect(block).not.toMatch(/opacity/);
  });

  it("keeps the global backstop for every other animation", () => {
    const body = ruleBody(block, "\\*::after");
    expect(body).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(body).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(body).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});
