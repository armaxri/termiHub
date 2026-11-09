import { describe, it, expect } from "vitest";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import { contrastRatio } from "./contrast";

/**
 * Toast close (x) button contrast (#5091). `toast.css` paints the close icon
 * with `--text-primary` on the toast surface (`--bg-dropdown`) and on the hover
 * background (`--bg-hover`). A graphical control must
 * reach WCAG 2.2 SC 1.4.11's 3:1 in every built-in theme; `--text-secondary`
 * (the previous colour) measured 2.9:1 on Solarized Dark and 2.5:1 on
 * Solarized Light.
 */
const UI_COMPONENT_MIN = 3;

const THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];

describe("toast close button contrast (WCAG 2.2 1.4.11)", () => {
  for (const theme of THEMES) {
    const fg = theme.colors.textPrimary;
    for (const surface of ["bgDropdown", "bgHover"] as const) {
      const bg = theme.colors[surface];
      it(`${theme.id} textPrimary (${fg}) reaches 3:1 on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
      });
    }
  }
});
