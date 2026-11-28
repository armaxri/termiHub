/**
 * #6155: a focus ring that survives Windows High Contrast (forced colors).
 *
 * Forced-colors mode drops `box-shadow`, so the shadow ring the text fields
 * and several primitives draw on focus disappears there. `global.css` carries
 * one `@media (forced-colors: active)` block that gives every focused element
 * an outline in a system colour, which forced colors keep.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const STYLES_DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(STYLES_DIR, "global.css"), "utf8");

/** The body of the first `@media (forced-colors: active)` block, braces balanced. */
function forcedColorsBlock(): string | null {
  const start = css.search(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)\s*\{/);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}

describe("forced-colors focus outline (#6155)", () => {
  const block = forcedColorsBlock();

  it("has a forced-colors block in global.css", () => {
    expect(block).not.toBeNull();
  });

  it("covers keyboard focus and the shadow-ringed text fields", () => {
    const selectors = block!.slice(0, block!.indexOf("{"));
    for (const sel of [":focus-visible", "input:focus", "select:focus", "textarea:focus"]) {
      expect(selectors).toContain(sel);
    }
  });

  it("draws a solid outline in a system colour at the shared ring width", () => {
    const body = block!.slice(block!.indexOf("{") + 1);
    const outline = body.match(/outline\s*:\s*([^;]+);/)?.[1] ?? "";
    expect(outline).toMatch(/var\(--focus-ring-width\)\s+solid\s+(Highlight|CanvasText)\b/);
    // It must beat the component rules that set `outline: none` on focus.
    expect(outline).toContain("!important");
    expect(body).toMatch(/outline-offset\s*:\s*var\(--focus-ring-offset\)/);
  });
});
