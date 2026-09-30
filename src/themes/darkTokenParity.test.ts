import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { darkTheme } from "./dark";
import { COLOR_TO_CSS_VAR } from "./engine";
import type { ThemeColors } from "./types";

/**
 * Dark-theme token parity (UI-001, #4013).
 *
 * `src/styles/variables.css` `:root` is the design-system source of truth, and
 * the theme engine writes `dark.ts` over it at runtime via `COLOR_TO_CSS_VAR`.
 * If the two drift, what renders depends on whether the engine has run yet —
 * the pre-theme first paint (and `index.html`'s pre-paint background) would
 * show one palette and the themed app another. This pins all three together.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const VARIABLES_CSS = readFileSync(join(SRC_DIR, "styles", "variables.css"), "utf8");
const INDEX_HTML = readFileSync(join(SRC_DIR, "..", "index.html"), "utf8");

/** The ANSI 16 have no `variables.css` counterpart by design (see dark.ts). */
const ANSI_KEYS = new Set<keyof ThemeColors>(
  (Object.keys(darkTheme.colors) as (keyof ThemeColors)[]).filter((k) => k.startsWith("ansi"))
);

/** Extract the body of the first top-level `:root { ... }` block. */
function rootBlock(css: string): string {
  const start = css.indexOf(":root {");
  if (start < 0) throw new Error("variables.css has no :root block");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i);
  }
  throw new Error("unterminated :root block");
}

/** Parse `--name: value;` declarations (comments stripped) from a CSS block. */
function parseCustomProperties(block: string): Map<string, string> {
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** Normalize a color literal so `#ABC` vs `#abc` or `rgba(1,2,3,0.5)` spacing never matter. */
function normalizeColor(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

const rootVars = parseCustomProperties(rootBlock(VARIABLES_CSS));

describe("dark theme token parity with variables.css (UI-001)", () => {
  const coreKeys = (Object.keys(COLOR_TO_CSS_VAR) as (keyof ThemeColors)[]).filter(
    (k) => !ANSI_KEYS.has(k)
  );

  it("covers the core token set", () => {
    // Guard against the filter silently emptying the parity check.
    expect(coreKeys.length).toBeGreaterThan(30);
    expect(ANSI_KEYS.size).toBe(16);
  });

  it.each(coreKeys)("%s is declared in variables.css :root", (key) => {
    expect(rootVars.has(COLOR_TO_CSS_VAR[key])).toBe(true);
  });

  it.each(coreKeys)("%s matches its variables.css value", (key) => {
    const cssValue = rootVars.get(COLOR_TO_CSS_VAR[key]);
    expect(cssValue).toBeDefined();
    expect(normalizeColor(darkTheme.colors[key])).toBe(normalizeColor(cssValue!));
  });

  it("ansiBlack tracks the terminal background", () => {
    expect(normalizeColor(darkTheme.colors.ansiBlack)).toBe(
      normalizeColor(darkTheme.colors.terminalBg)
    );
  });
});

describe("index.html pre-paint background (UI-001)", () => {
  const match = INDEX_HTML.match(
    /html,\s*body\s*\{\s*background-color:\s*(#[0-9a-fA-F]{3,8})\s*;?/
  );

  it("declares a pre-paint background color", () => {
    expect(match).not.toBeNull();
  });

  it("equals the dark theme bgPrimary and variables.css --bg-primary", () => {
    const prePaint = normalizeColor(match![1]);
    expect(prePaint).toBe("#0f1117");
    expect(normalizeColor(darkTheme.colors.bgPrimary)).toBe(prePaint);
    expect(normalizeColor(rootVars.get("--bg-primary")!)).toBe(prePaint);
  });

  it("matches the dark accent to variables.css --accent-color", () => {
    expect(normalizeColor(darkTheme.colors.accentColor)).toBe(
      normalizeColor(rootVars.get("--accent-color")!)
    );
  });
});
