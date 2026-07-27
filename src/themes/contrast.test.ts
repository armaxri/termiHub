import { describe, it, expect } from "vitest";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";

/**
 * WCAG contrast regression test (accessibility audit, #2070).
 *
 * Guards the built-in dark/light theme tokens that are used as *text* colors
 * against dropping below the WCAG 2.2 AA minimum contrast ratio of 4.5:1 for
 * normal-size text. `--text-muted` and (in the light theme) `--color-warning`
 * both previously failed AA and were darkened/lightened here; this test locks
 * that in so a future palette tweak cannot silently regress it.
 *
 * The two surfaces checked are the primary background and the sidebar
 * background — the two backgrounds these tokens actually render on across the
 * app's 18 consuming CSS files.
 *
 * Note: the Solarized themes are intentionally excluded — Solarized is a
 * fixed, well-known palette whose muted tones do not meet AA by design, and
 * #2070 scopes the fix to the built-in dark/light themes only.
 */

const AA_NORMAL_TEXT = 4.5;

/** sRGB relative luminance per WCAG 2.x, from a `#rrggbb` hex string. */
function relativeLuminance(hex: string): number {
  const int = parseInt(hex.slice(1), 16);
  const channels = [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const [r, g, b] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colors (always >= 1). */
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme text contrast (WCAG 2.2 AA)", () => {
  const cases = [
    { theme: darkTheme, token: "textMuted" as const },
    { theme: lightTheme, token: "textMuted" as const },
    { theme: lightTheme, token: "colorWarning" as const },
  ];

  for (const { theme, token } of cases) {
    const fg = theme.colors[token];
    const surfaces: [string, string][] = [
      ["bgPrimary", theme.colors.bgPrimary],
      ["sidebarBg", theme.colors.sidebarBg],
    ];

    for (const [surfaceName, bg] of surfaces) {
      it(`${theme.id} ${token} (${fg}) meets AA on ${surfaceName} (${bg})`, () => {
        const ratio = contrastRatio(fg, bg);
        expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }
});
