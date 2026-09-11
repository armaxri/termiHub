/**
 * A11Y-007: the shared focus indicator must be strong and clearly visible.
 *
 * Primitives (buttons, inputs, selects, toggles, checkboxes, the modal close
 * button) render their `:focus-visible` ring from `--shadow-focus`, which
 * *replaces* the strong global indicator. It was a single 22%-alpha ring — faint
 * enough to lose against the app's dark surfaces and below the WCAG 1.4.11 3:1
 * non-text-contrast bar. This guard pins that `--shadow-focus` is a strong,
 * solid ring built from the same `--focus-border` token the global
 * `:focus-visible` indicator uses, and never regresses to a translucent ring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const STYLES_DIR = dirname(fileURLToPath(import.meta.url));

/** Extract a single custom-property declaration's value from a CSS file. */
function tokenValue(css: string, token: string): string | null {
  const re = new RegExp(`${token}\\s*:\\s*([^;]+);`, "i");
  const m = css.match(re);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

describe("focus ring strength (A11Y-007)", () => {
  const variables = readFileSync(join(STYLES_DIR, "variables.css"), "utf8");
  const shadowFocus = tokenValue(variables, "--shadow-focus");

  it("defines --shadow-focus", () => {
    expect(shadowFocus).not.toBeNull();
  });

  it("builds the ring from the solid --focus-border token", () => {
    expect(shadowFocus).toContain("var(--focus-border)");
  });

  it("does not use the former faint 22%-alpha ring", () => {
    // The weak indicator was `rgba(61, 125, 232, 0.22)`; any translucent rgba
    // ring here would again override the strong global indicator.
    expect(shadowFocus).not.toMatch(/rgba\([^)]*0?\.\d+\s*\)/i);
  });
});
