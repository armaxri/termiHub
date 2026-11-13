import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { adjustForContrast, contrastRatio, relativeLuminance } from "./contrast";
import { applyTheme, controlVariables } from "./engine";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";

/**
 * Solarized selected rows, success colour and form controls (#5639, UI review
 * of product run 20261113T080834Z: R-053, R-060, R-061, R-129, R-130).
 *
 * - The Solarized Light selected row was base2 on the base3 sidebar (1.14:1);
 *   only the 2px bar marked it. It now takes the theme's active tone.
 * - Canonical Solarized green (#859900) sits 23° of hue from the warning
 *   yellow, so "connected" read as "connecting". Success now starts from
 *   Solarized green rotated to a clear green (same OKLCH lightness and chroma).
 * - Solarized Light placeholders were base02, a step from entered base03 text,
 *   and the off toggle drew a dark base02 knob, which read as "on".
 */

const AA_NORMAL_TEXT = 4.5;
const UI_COMPONENT_MIN = 3;
const SOLARIZED = [solarizedDarkTheme, solarizedLightTheme];

/** Canonical Solarized green at OKLCH hue 140° (canonical: 118.6°), same L and C. */
const SOLARIZED_SUCCESS_GREEN = "#56a345";

/** HSL hue in degrees of a `#rrggbb` colour. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

const hueDistance = (a: string, b: string) => {
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
};

describe("solarized light selected row (#5639 R-053, R-129)", () => {
  const { colors, selection } = solarizedLightTheme;
  if (!selection) throw new Error("solarized light defines no selection surfaces");

  it("the selected row is the theme's active tone, clearly darker than the sidebar", () => {
    expect(selection.bg).toBe(colors.bgActive);
    expect(contrastRatio(selection.bg, colors.sidebarBg)).toBeGreaterThanOrEqual(1.4);
  });

  it("the selected row differs visibly from a hovered unselected row", () => {
    expect(contrastRatio(selection.bg, colors.bgHover)).toBeGreaterThanOrEqual(1.1);
  });

  it("hovering a selected row is a visible step (was 1.08:1)", () => {
    expect(contrastRatio(selection.bg, selection.bgHover)).toBeGreaterThanOrEqual(1.1);
  });

  it("the selection indicator reaches 3:1 on the sidebar and on both row states", () => {
    for (const bg of [colors.sidebarBg, selection.bg, selection.bgHover]) {
      expect(contrastRatio(selection.indicator, bg)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
    }
  });

  it("the row text keeps AA on both row states", () => {
    for (const bg of [selection.bg, selection.bgHover]) {
      for (const fg of [colors.textPrimary, colors.textSecondaryOnSelection]) {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
  });

  it("the inline Connect button turns to the text accent on hover", () => {
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../components/Sidebar/ConnectionList.css"),
      "utf8"
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toMatch(
      /\.connection-tree__connect:hover:not\(\[aria-disabled="true"\]\)\s*\{[^}]*color:\s*var\(--text-accent\)/
    );
  });

  for (const theme of [lightTheme, darkTheme, solarizedLightTheme, solarizedDarkTheme]) {
    it(`${theme.id}: the accent Connect icon reaches 3:1 on the hovered row`, () => {
      const rowBg = theme.selection?.bgHover ?? theme.colors.bgHover;
      expect(contrastRatio(theme.colors.textAccent, rowBg)).toBeGreaterThanOrEqual(
        UI_COMPONENT_MIN
      );
    });
  }
});

describe("solarized success reads as green, not warning (#5639 R-060)", () => {
  const TEXT = ["bgPrimary", "bgSecondary", "sidebarBg", "bgDropdown"] as const;
  const DOTS = ["bgPrimary", "bgSecondary", "sidebarBg"] as const;

  for (const theme of SOLARIZED) {
    const c = theme.colors;
    it(`${theme.id} success is the minimal contrast nudge of the rotated green`, () => {
      expect(c.colorSuccess).toBe(
        adjustForContrast(
          SOLARIZED_SUCCESS_GREEN,
          TEXT.map((s) => c[s]),
          AA_NORMAL_TEXT,
          1
        )
      );
      expect(c.stateConnected).toBe(
        adjustForContrast(
          SOLARIZED_SUCCESS_GREEN,
          DOTS.map((s) => c[s]),
          UI_COMPONENT_MIN,
          1
        )
      );
    });

    it(`${theme.id} success sits at least 45° of hue away from warning (was 23°)`, () => {
      expect(hueDistance(c.colorSuccess, c.colorWarning)).toBeGreaterThanOrEqual(45);
      expect(hueDistance(c.stateConnected, c.stateConnecting)).toBeGreaterThanOrEqual(45);
    });

    it(`${theme.id} success reads as green (hue 90-150°)`, () => {
      for (const token of [c.colorSuccess, c.stateConnected]) {
        expect(hue(token)).toBeGreaterThanOrEqual(90);
        expect(hue(token)).toBeLessThanOrEqual(150);
      }
    });
  }

  it("documents the gap: canonical green sits within 25° of the warning yellow", () => {
    expect(hueDistance("#859900", "#b58900")).toBeLessThan(25);
  });
});

describe("solarized light form controls (#5639 R-061, R-130)", () => {
  const { colors, controls } = solarizedLightTheme;
  if (!controls) throw new Error("solarized light defines no control overrides");

  it("placeholders are muted base01: AA on the input, clearly lighter than entered text", () => {
    expect(controls.placeholder).toBe(colors.textMuted);
    expect(contrastRatio(controls.placeholder!, colors.bgInput)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT
    );
    expect(
      contrastRatio(colors.textPrimary, colors.bgInput) /
        contrastRatio(controls.placeholder!, colors.bgInput)
    ).toBeGreaterThanOrEqual(2);
  });

  it("the off toggle is a light knob on a mid-grey track", () => {
    const track = controls.toggleOffTrack!;
    const thumb = controls.toggleOffThumb!;
    expect(relativeLuminance(thumb)!).toBeGreaterThan(relativeLuminance(track)!);
    expect(contrastRatio(thumb, track)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
    expect(contrastRatio(track, colors.bgPrimary)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
  });

  it("the off knob differs from the on knob's position colour scheme (on = accent track)", () => {
    expect(contrastRatio(controls.toggleOffTrack!, colors.accentColor)).toBeGreaterThan(1);
    expect(controls.toggleOffTrack).not.toBe(colors.accentColor);
  });

  it("secondary buttons get a base1 border that is visible on the page", () => {
    expect(controls.secondaryButtonBorder).toBe("#93a1a1");
    expect(contrastRatio(controls.secondaryButtonBorder!, colors.bgPrimary)).toBeGreaterThan(
      contrastRatio(colors.borderPrimary, colors.bgPrimary)
    );
  });

  it("applying the theme writes the control variables; other themes clear them", () => {
    applyTheme("solarized-light");
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--input-placeholder")).toBe(controls.placeholder);
    expect(style.getPropertyValue("--toggle-off-track")).toBe(controls.toggleOffTrack);
    expect(style.getPropertyValue("--toggle-off-thumb")).toBe(controls.toggleOffThumb);
    expect(style.getPropertyValue("--btn-secondary-border")).toBe(controls.secondaryButtonBorder);
    for (const other of ["solarized-dark", "dark", "light"]) {
      applyTheme(other);
      for (const v of Object.keys(controlVariables(solarizedLightTheme))) {
        expect(style.getPropertyValue(v)).toBe("");
      }
    }
  });
});

describe("control variables back onto the plain tokens (#5639)", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
  const variables = readFileSync(join(SRC, "styles/variables.css"), "utf8");
  const ui = readFileSync(join(SRC, "components/ui/ui.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    ""
  );

  it("variables.css keeps the previous look as the default", () => {
    expect(variables).toMatch(/--input-placeholder:\s*var\(--text-secondary\);/);
    expect(variables).toMatch(/--toggle-off-track:\s*var\(--bg-active\);/);
    expect(variables).toMatch(/--toggle-off-thumb:\s*var\(--text-secondary\);/);
    expect(variables).toMatch(/--btn-secondary-border:\s*var\(--border-primary\);/);
  });

  it("the primitives paint the control variables", () => {
    for (const sel of [".ui-input::placeholder", ".ui-textarea::placeholder"]) {
      const body = new RegExp(`${sel.replace(/[.:-]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(ui)?.[1];
      expect(body).toMatch(/color:\s*var\(--input-placeholder\)/);
    }
    expect(ui).toMatch(
      /\.ui-select__trigger\[data-placeholder\]\s*\{[^}]*color:\s*var\(--input-placeholder\)/
    );
    expect(ui).toMatch(/\.ui-toggle\s*\{[^}]*background:\s*var\(--toggle-off-track\)/);
    expect(ui).toMatch(/\.ui-toggle__thumb\s*\{[^}]*background:\s*var\(--toggle-off-thumb\)/);
    expect(ui).toMatch(
      /\.ui-btn--secondary\s*\{[^}]*border-color:\s*var\(--btn-secondary-border\)/
    );
  });

  it("themes without overrides set no control variables", () => {
    for (const theme of [darkTheme, lightTheme, solarizedDarkTheme]) {
      expect(Object.values(controlVariables(theme)).every((v) => v === null)).toBe(true);
    }
  });
});
