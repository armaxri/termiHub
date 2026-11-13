import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { contrastRatio } from "./contrast";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";

/**
 * Settings ▸ Editor custom file-type mappings (#5722).
 *
 * The custom mappings list painted its language with `--text-disabled`, below
 * 4.5:1. Each item is a raised `--bg-tertiary` row (`--bg-hover` on hover),
 * where plain `--text-secondary` is only 4.28:1 in Solarized Dark, so the
 * language uses `--text-secondary-on-selection`. This pins both halves: the
 * token passes AA on both row surfaces in every built-in theme, and the CSS
 * reads it rather than the disabled grey.
 */

const AA_NORMAL_TEXT = 4.5;
const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];
const ROW_SURFACES = ["bgTertiary", "bgHover"] as const;

describe("custom file-type mapping language contrast (WCAG 2.2 AA)", () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const surface of ROW_SURFACES) {
      it(`${theme.id} textSecondaryOnSelection meets AA on ${surface}`, () => {
        const ratio = contrastRatio(theme.colors.textSecondaryOnSelection, theme.colors[surface]);
        expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("documents why: plain textSecondary misses AA on the raised row in Solarized Dark", () => {
    const { textSecondary, bgTertiary } = solarizedDarkTheme.colors;
    expect(contrastRatio(textSecondary, bgTertiary)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

const CSS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "components/Settings/FileTypeSettings.css"
);

/** The declarations of the rule headed exactly by `selector` in `css`. */
function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

describe("custom mapping language reads the secondary-text tokens", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it.each([
    [
      ".settings-panel__file-path.file-type-settings__custom-language",
      "--text-secondary-on-selection",
    ],
  ])("%s uses var(%s)", (selector, token) => {
    const body = ruleBody(css, selector);
    expect(body, `${selector} rule not found`).toBeDefined();
    expect(body).toMatch(new RegExp(`(^|[\\s;])color:\\s*var\\(${token}\\)`));
    expect(body).not.toMatch(/--text-disabled/);
  });
});
