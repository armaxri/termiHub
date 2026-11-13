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
 * Empty-state text links (R-139, #5702).
 *
 * The Connections empty state's links were painted with `--accent-color`, the
 * button-fill token. On Solarized Dark that blue (#227bba) is darkened so white
 * button text passes, which leaves it at ~3:1 as *text* on the sidebar — well
 * under the body text beside it. Inline links use `--text-link`, the token each
 * theme tunes to reach WCAG AA as text. This pins both halves: every built-in
 * theme's link token passes on the surfaces the empty states sit on, and the
 * link classes read that token rather than the accent fill.
 */

const AA_NORMAL_TEXT = 4.5;
const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];
const SURFACES = ["sidebarBg", "bgPrimary", "bgSecondary"] as const;

describe("empty-state link colour contrast (WCAG 2.2 AA)", () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const surface of SURFACES) {
      it(`${theme.id} textLink meets AA on ${surface}`, () => {
        const ratio = contrastRatio(theme.colors.textLink, theme.colors[surface]);
        expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("documents the regression: Solarized Dark's accent fill fails AA as sidebar text", () => {
    const { accentColor, sidebarBg } = solarizedDarkTheme.colors;
    expect(contrastRatio(accentColor, sidebarBg)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [CSS file under src/, link selector] whose text colour must be the link token. */
const LINK_RULES: [string, string][] = [
  ["components/Sidebar/ConnectionList.css", ".connections-empty__link"],
  ["components/Sidebar/ConnectionList.css", ".connections-empty__link:hover"],
  ["components/ui/ui.css", ".ui-empty__link"],
];

/** The declarations of the rule headed exactly by `selector` in `css`. */
function ruleBody(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

describe("empty-state links read the link token, not the accent fill", () => {
  it.each(LINK_RULES)("%s %s uses var(--text-link)", (file, selector) => {
    const body = ruleBody(readFileSync(join(SRC_DIR, file), "utf8"), selector);
    expect(body, `${selector} rule not found in ${file}`).toBeDefined();
    expect(body).toMatch(/(^|[\s;])color:\s*var\(--text-link\)/);
    expect(body).not.toMatch(/(^|[\s;])color:\s*var\(--accent-(color|hover)\)/);
  });
});
