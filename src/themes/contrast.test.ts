import { describe, it, expect } from "vitest";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import {
  ANSI_COLOR_KEYS,
  ANSI_MIN_CONTRAST,
  adjustForContrast,
  adjustLightnessForContrast,
  applyAnsiContrastFloor,
  contrastRatio,
  deriveTextMutedOnSelection,
  deriveTextSecondaryOnSelection,
} from "./contrast";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import { COLOR_TO_CSS_VAR, applyTheme, getXtermTheme, previewTheme } from "./engine";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { createCustomTheme, resolveCustomTheme } from "./customThemes";
import { parsePluginTheme } from "./pluginThemes";

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
      // Popovers/menus (#5165: spawn-picker hints and other former
      // `--text-disabled` sites now render `--text-muted` here).
      ["bgDropdown", theme.colors.bgDropdown],
    ];

    for (const [surfaceName, bg] of surfaces) {
      it(`${theme.id} ${token} (${fg}) meets AA on ${surfaceName} (${bg})`, () => {
        const ratio = contrastRatio(fg, bg);
        expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }
});

/**
 * Secondary chrome text (#4948): `--text-secondary` renders on the status bar
 * (`--bg-secondary`) and on inactive tab titles (`--tab-bg`). Light's value
 * previously measured 4.34:1 and 4.08:1 on those surfaces; Dark's measured
 * 4.31:1 on `tabBg` (#4956) before it was lightened to `#808a9c` (4.61:1).
 */
describe("secondary chrome text contrast (WCAG 2.2 AA)", () => {
  const cases = [
    { theme: darkTheme, surface: "bgSecondary" as const },
    { theme: darkTheme, surface: "tabBg" as const },
    { theme: lightTheme, surface: "bgSecondary" as const },
    { theme: lightTheme, surface: "tabBg" as const },
  ];

  for (const { theme, surface } of cases) {
    const fg = theme.colors.textSecondary;
    const bg = theme.colors[surface];
    it(`${theme.id} textSecondary (${fg}) meets AA on ${surface} (${bg})`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }
});

/**
 * Muted hints on hovered / selected rows (#5200). Row hover and selection
 * paint `--bg-hover` / `--bg-active`, which sit closer to `--text-muted` than
 * the plain surfaces: Dark measured 4.17:1 selected, Light 4.25:1 hovered and
 * 3.59:1 selected. Row hints switch to `--text-muted-on-selection` in those
 * states, and this locks it at AA on both row backgrounds. (Solarized is
 * tracked separately in #5190 and keeps its palette value.)
 */
describe("muted text on hovered/selected rows (WCAG 2.2 AA, #5200)", () => {
  for (const theme of [darkTheme, lightTheme]) {
    const fg = theme.colors.textMutedOnSelection;
    for (const surface of ["bgHover", "bgActive"] as const) {
      const bg = theme.colors[surface];
      it(`${theme.id} textMutedOnSelection (${fg}) meets AA on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }

    it(`${theme.id} pins the derived value, so a custom copy renders the same`, () => {
      expect(fg).toBe(deriveTextMutedOnSelection(theme.colors));
    });
  }

  it("documents the gap the token closes: plain textMuted fails on a row state", () => {
    for (const theme of [darkTheme, lightTheme]) {
      const worst = Math.min(
        contrastRatio(theme.colors.textMuted, theme.colors.bgHover),
        contrastRatio(theme.colors.textMuted, theme.colors.bgActive)
      );
      expect(worst).toBeLessThan(AA_NORMAL_TEXT);
    }
  });

  it("keeps the Solarized palette value untouched (#5190)", () => {
    for (const theme of [solarizedDarkTheme, solarizedLightTheme]) {
      expect(theme.colors.textMutedOnSelection).toBe(theme.colors.textMuted);
    }
  });

  it("maps to --text-muted-on-selection and is not user-editable", () => {
    expect(COLOR_TO_CSS_VAR.textMutedOnSelection).toBe("--text-muted-on-selection");
    expect(COLOR_TOKEN_KEYS).not.toContain("textMutedOnSelection");
  });

  it("custom themes derive it from their (possibly edited) muted colour", () => {
    const plain = resolveCustomTheme(createCustomTheme("light", "Plain"));
    expect(plain.colors.textMutedOnSelection).toBe(lightTheme.colors.textMutedOnSelection);
    const edited = createCustomTheme("dark", "Dim");
    edited.colors.textMuted = "#6a7080";
    const resolved = resolveCustomTheme(edited).colors;
    expect(contrastRatio(resolved.textMutedOnSelection, resolved.bgActive)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT
    );
  });

  it("plugin themes derive it unless they set it", () => {
    const full: Record<string, string> = {};
    for (const key of COLOR_TOKEN_KEYS) full[key] = "#123456";
    const entry = { id: "paper", name: "Paper", file: "paper.json" };
    const json = (extra: Record<string, string>) =>
      JSON.stringify({ colorScheme: "light", colors: { ...full, ...extra } });
    const derived = parsePluginTheme(
      "acme",
      entry,
      json({ textMuted: "#777777", bgActive: "#3a3a3a", bgHover: "#333333" })
    );
    expect(contrastRatio(derived.colors.textMutedOnSelection, "#3a3a3a")).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT
    );
    const pinned = parsePluginTheme("acme", entry, json({ textMutedOnSelection: "#abcdef" }));
    expect(pinned.colors.textMutedOnSelection).toBe("#abcdef");
  });

  it("derives an AA value for a failing muted colour and keeps a passing one", () => {
    const failing = { textMuted: "#777777", bgHover: "#333333", bgActive: "#3a3a3a" };
    const derived = deriveTextMutedOnSelection(failing);
    expect(contrastRatio(derived, failing.bgActive)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    const passing = { textMuted: "#bbbbbb", bgHover: "#333333", bgActive: "#3a3a3a" };
    expect(deriveTextMutedOnSelection(passing)).toBe("#bbbbbb");
  });
});

/**
 * Secondary text on hovered / selected rows (#5249). `--text-secondary` on the
 * row states measured Dark 4.44:1 (bgHover) / 4.06:1 (bgActive) and Light
 * 4.00:1 (bgActive). Row states redirect it to `--text-secondary-on-selection`
 * (pinned by src/styles/secondaryOnSelection.test.ts), and this locks that
 * token at AA on both row backgrounds. Solarized is tracked in #5190.
 */
describe("secondary text on hovered/selected rows (WCAG 2.2 AA, #5249)", () => {
  for (const theme of [darkTheme, lightTheme]) {
    const fg = theme.colors.textSecondaryOnSelection;
    for (const surface of ["bgHover", "bgActive"] as const) {
      const bg = theme.colors[surface];
      it(`${theme.id} textSecondaryOnSelection (${fg}) meets AA on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }

    it(`${theme.id} pins the derived value, so a custom copy renders the same`, () => {
      expect(fg).toBe(deriveTextSecondaryOnSelection(theme.colors));
    });
  }

  it("documents the gap the token closes: plain textSecondary fails on a row state", () => {
    for (const theme of [darkTheme, lightTheme]) {
      const worst = Math.min(
        contrastRatio(theme.colors.textSecondary, theme.colors.bgHover),
        contrastRatio(theme.colors.textSecondary, theme.colors.bgActive)
      );
      expect(worst).toBeLessThan(AA_NORMAL_TEXT);
    }
  });

  it("keeps the Solarized palette value untouched (#5190)", () => {
    for (const theme of [solarizedDarkTheme, solarizedLightTheme]) {
      expect(theme.colors.textSecondaryOnSelection).toBe(theme.colors.textSecondary);
    }
  });

  it("maps to --text-secondary-on-selection and is not user-editable", () => {
    expect(COLOR_TO_CSS_VAR.textSecondaryOnSelection).toBe("--text-secondary-on-selection");
    expect(COLOR_TOKEN_KEYS).not.toContain("textSecondaryOnSelection");
  });

  it("custom themes derive it from their (possibly edited) secondary colour", () => {
    const plain = resolveCustomTheme(createCustomTheme("light", "Plain"));
    expect(plain.colors.textSecondaryOnSelection).toBe(lightTheme.colors.textSecondaryOnSelection);
    const edited = createCustomTheme("dark", "Dim");
    edited.colors.textSecondary = "#6a7080";
    const resolved = resolveCustomTheme(edited).colors;
    expect(
      contrastRatio(resolved.textSecondaryOnSelection, resolved.bgActive)
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it("plugin themes derive it unless they set it", () => {
    const full: Record<string, string> = {};
    for (const key of COLOR_TOKEN_KEYS) full[key] = "#123456";
    const entry = { id: "paper", name: "Paper", file: "paper.json" };
    const json = (extra: Record<string, string>) =>
      JSON.stringify({ colorScheme: "light", colors: { ...full, ...extra } });
    const derived = parsePluginTheme(
      "acme",
      entry,
      json({ textSecondary: "#777777", bgActive: "#3a3a3a", bgHover: "#333333" })
    );
    expect(
      contrastRatio(derived.colors.textSecondaryOnSelection, "#3a3a3a")
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    const pinned = parsePluginTheme("acme", entry, json({ textSecondaryOnSelection: "#abcdef" }));
    expect(pinned.colors.textSecondaryOnSelection).toBe("#abcdef");
  });

  it("derives an AA value for a failing secondary colour and keeps a passing one", () => {
    const failing = { textSecondary: "#777777", bgHover: "#333333", bgActive: "#3a3a3a" };
    const derived = deriveTextSecondaryOnSelection(failing);
    expect(contrastRatio(derived, failing.bgActive)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    const passing = { textSecondary: "#bbbbbb", bgHover: "#333333", bgActive: "#3a3a3a" };
    expect(deriveTextSecondaryOnSelection(passing)).toBe("#bbbbbb");
  });
});

describe("adjustForContrast (#5008)", () => {
  it("returns a passing colour unchanged", () => {
    expect(adjustForContrast("#ffffff", ["#000000"])).toBe("#ffffff");
  });

  it("lightens towards white on dark backgrounds", () => {
    const out = adjustForContrast("#222222", ["#161b24", "#1c2130"]);
    expect(contrastRatio(out, "#161b24")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(out, "#1c2130")).toBeGreaterThanOrEqual(3);
  });

  it("darkens towards black on light backgrounds", () => {
    const out = adjustForContrast("#eeeeee", ["#ffffff", "#f3f3f3"]);
    expect(contrastRatio(out, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("leaves non-hex input or non-hex backgrounds alone", () => {
    expect(adjustForContrast("red", ["#000000"])).toBe("red");
    expect(adjustForContrast("#111111", ["var(--x)"])).toBe("#111111");
  });
});

const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];

/** OKLCH hue in degrees, for asserting a nudge kept the colour's identity. */
function oklchHue(hex: string): { hue: number; chroma: number } {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const sh = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * sh;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * sh;
  return { hue: (Math.atan2(bb, a) * 180) / Math.PI, chroma: Math.hypot(a, bb) };
}

/**
 * Inactive activity-bar icons (#5192, WCAG 1.4.11 non-text 3:1). The icons are
 * the only identification of the primary navigation controls. Dark measured
 * 2.91:1, Solarized Dark 2.79:1 and Solarized Light 2.42:1 before the fix.
 * Active/hover paint `activityBarActive`, which must stay clearly distinct.
 */
describe("inactive activity-bar icon contrast (WCAG 1.4.11, #5192)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const { activityBarInactive: fg, activityBarBg: bg, activityBarActive } = theme.colors;
    it(`${theme.id} activityBarInactive (${fg}) reaches 3:1 on activityBarBg (${bg})`, () => {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(3);
    });

    it(`${theme.id} active/hover icons stay clearly distinct from inactive`, () => {
      expect(contrastRatio(activityBarActive, bg)).toBeGreaterThan(3 * contrastRatio(fg, bg));
      expect(contrastRatio(activityBarActive, fg)).toBeGreaterThanOrEqual(3);
    });
  }
});

/**
 * ANSI palette floor (#5191): every ANSI colour, normal and bright, reaches
 * 3:1 on its theme's terminal background. Light's white/bright-white used to
 * equal the background (1.04:1 / 1.00:1), and the Solarized brblack (dark) and
 * brwhite (light) are canonically the background tone (1.00:1).
 */
describe("ansi palette contrast on the terminal background (#5191)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const bg = theme.colors.terminalBg;
    for (const key of ANSI_COLOR_KEYS) {
      const fg = theme.colors[key];
      it(`${theme.id} ${key} (${fg}) reaches 3:1 on terminalBg (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(ANSI_MIN_CONTRAST);
      });
    }

    it(`${theme.id} renders its palette unchanged (the runtime floor is a no-op)`, () => {
      applyTheme(theme.id);
      const xterm = getXtermTheme();
      expect(xterm.white).toBe(theme.colors.ansiWhite);
      expect(xterm.brightWhite).toBe(theme.colors.ansiBrightWhite);
      expect(xterm.black).toBe(theme.colors.ansiBlack);
      expect(xterm.brightBlack).toBe(theme.colors.ansiBrightBlack);
      expect(applyAnsiContrastFloor(theme.colors)).toEqual(
        Object.fromEntries(ANSI_COLOR_KEYS.map((k) => [k, theme.colors[k]]))
      );
    });
  }

  it("floors a plugin theme whose ansiWhite equals its terminal background", () => {
    const full: Record<string, string> = {};
    for (const key of COLOR_TOKEN_KEYS) full[key] = "#123456";
    const json = JSON.stringify({
      colorScheme: "light",
      colors: { ...full, terminalBg: "#ffffff", ansiWhite: "#ffffff", ansiBrightWhite: "#fafafa" },
    });
    const plugin = parsePluginTheme("acme", { id: "paper", name: "Paper", file: "p.json" }, json);
    previewTheme(plugin);
    const xterm = getXtermTheme();
    expect(contrastRatio(xterm.white, "#ffffff")).toBeGreaterThanOrEqual(ANSI_MIN_CONTRAST);
    expect(contrastRatio(xterm.brightWhite, "#ffffff")).toBeGreaterThanOrEqual(ANSI_MIN_CONTRAST);
    applyTheme("dark");
  });

  it("floors an edited custom theme too", () => {
    const custom = createCustomTheme("dark", "Ink");
    custom.colors.ansiBrightBlack = custom.colors.terminalBg;
    previewTheme(custom);
    const xterm = getXtermTheme();
    expect(contrastRatio(xterm.brightBlack, xterm.background)).toBeGreaterThanOrEqual(
      ANSI_MIN_CONTRAST
    );
    applyTheme("dark");
  });
});

describe("adjustLightnessForContrast (#5191)", () => {
  it("returns a passing colour unchanged", () => {
    expect(adjustLightnessForContrast("#e5e5e5", "#0f1117")).toBe("#e5e5e5");
  });

  it("leaves non-hex input alone", () => {
    expect(adjustLightnessForContrast("red", "#ffffff")).toBe("red");
    expect(adjustLightnessForContrast("#ffffff", "var(--x)")).toBe("#ffffff");
  });

  it("darkens on a light background and lightens on a dark one, just to the floor", () => {
    const dark = adjustLightnessForContrast("#fafafa", "#ffffff");
    expect(contrastRatio(dark, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dark, "#ffffff")).toBeLessThan(3.1);
    const light = adjustLightnessForContrast("#073642", "#002b36");
    expect(contrastRatio(light, "#002b36")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light, "#002b36")).toBeLessThan(3.1);
  });

  it("produced the shipped built-in values from the original palettes", () => {
    // [theme, token, original value, background]: the shipped value is exactly
    // the smallest lightness nudge of the original, so the change is minimal.
    const cases: [typeof darkTheme, keyof typeof darkTheme.colors, string, string][] = [
      [darkTheme, "activityBarInactive", "#525d6e", darkTheme.colors.activityBarBg],
      [darkTheme, "ansiBlack", "#0f1117", darkTheme.colors.terminalBg],
      [lightTheme, "ansiWhite", "#fafafa", lightTheme.colors.terminalBg],
      [lightTheme, "ansiBrightGreen", "#98c379", lightTheme.colors.terminalBg],
      [lightTheme, "ansiBrightYellow", "#e5c07b", lightTheme.colors.terminalBg],
      [lightTheme, "ansiBrightBlue", "#61afef", lightTheme.colors.terminalBg],
      [lightTheme, "ansiBrightMagenta", "#c678dd", lightTheme.colors.terminalBg],
      [lightTheme, "ansiBrightCyan", "#56b6c2", lightTheme.colors.terminalBg],
      [lightTheme, "ansiBrightWhite", "#ffffff", lightTheme.colors.terminalBg],
      [solarizedDarkTheme, "activityBarInactive", "#586e75", "#002b36"],
      [solarizedDarkTheme, "ansiBlack", "#073642", "#002b36"],
      [solarizedDarkTheme, "ansiBrightBlack", "#002b36", "#002b36"],
      [solarizedDarkTheme, "ansiBrightGreen", "#586e75", "#002b36"],
      [solarizedLightTheme, "activityBarInactive", "#586e75", "#073642"],
      [solarizedLightTheme, "ansiGreen", "#859900", "#fdf6e3"],
      [solarizedLightTheme, "ansiYellow", "#b58900", "#fdf6e3"],
      [solarizedLightTheme, "ansiCyan", "#2aa198", "#fdf6e3"],
      [solarizedLightTheme, "ansiWhite", "#eee8d5", "#fdf6e3"],
      [solarizedLightTheme, "ansiBrightBlue", "#839496", "#fdf6e3"],
      [solarizedLightTheme, "ansiBrightCyan", "#93a1a1", "#fdf6e3"],
      [solarizedLightTheme, "ansiBrightWhite", "#fdf6e3", "#fdf6e3"],
    ];
    for (const [theme, key, original, bg] of cases) {
      expect(theme.colors[key], `${theme.id} ${key}`).toBe(
        adjustLightnessForContrast(original, bg)
      );
    }
  });

  it("keeps the hue of a saturated colour", () => {
    for (const [color, bg] of [
      ["#61afef", "#ffffff"],
      ["#e5c07b", "#ffffff"],
      ["#859900", "#fdf6e3"],
      ["#586e75", "#002b36"],
    ]) {
      const out = adjustLightnessForContrast(color, bg);
      expect(out).not.toBe(color);
      expect(Math.abs(oklchHue(out).hue - oklchHue(color).hue)).toBeLessThan(3);
    }
  });
});
