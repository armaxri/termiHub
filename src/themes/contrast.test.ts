import { describe, it, expect } from "vitest";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import {
  adjustForContrast,
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
 * All four built-in themes are graded. The Solarized themes used to be
 * excluded; #5190 remapped their text roles within the canonical Solarized
 * palette so they meet AA too (see "solarized text tokens" below).
 */

const AA_NORMAL_TEXT = 4.5;
/** WCAG 2.2 SC 1.4.11: non-text UI components and indicators. */
const UI_COMPONENT_MIN = 3;

const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];
const SOLARIZED_THEMES = [solarizedDarkTheme, solarizedLightTheme];

/** Ethan Schoonover's canonical 16 Solarized colours (base03…base3 + 8 accents). */
const SOLARIZED_PALETTE: Record<string, string> = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
};

describe("theme text contrast (WCAG 2.2 AA)", () => {
  const cases = [
    ...BUILT_IN_THEMES.map((theme) => ({ theme, token: "textMuted" as const })),
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
  const cases = BUILT_IN_THEMES.flatMap((theme) =>
    (["bgSecondary", "tabBg"] as const).map((surface) => ({ theme, surface }))
  );

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
 * states, and this locks it at AA on both row backgrounds. Dark and Light pin
 * the derived value; Solarized pins a canonical palette tone instead (#5190).
 */
describe("muted text on hovered/selected rows (WCAG 2.2 AA, #5200)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const fg = theme.colors.textMutedOnSelection;
    for (const surface of ["bgHover", "bgActive"] as const) {
      const bg = theme.colors[surface];
      it(`${theme.id} textMutedOnSelection (${fg}) meets AA on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  for (const theme of [darkTheme, lightTheme]) {
    it(`${theme.id} pins the derived value, so a custom copy renders the same`, () => {
      expect(theme.colors.textMutedOnSelection).toBe(deriveTextMutedOnSelection(theme.colors));
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
 * token at AA on both row backgrounds in all four themes (Solarized since #5190).
 */
describe("secondary text on hovered/selected rows (WCAG 2.2 AA, #5249)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const fg = theme.colors.textSecondaryOnSelection;
    for (const surface of ["bgHover", "bgActive"] as const) {
      const bg = theme.colors[surface];
      it(`${theme.id} textSecondaryOnSelection (${fg}) meets AA on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  for (const theme of [darkTheme, lightTheme]) {
    it(`${theme.id} pins the derived value, so a custom copy renders the same`, () => {
      expect(theme.colors.textSecondaryOnSelection).toBe(
        deriveTextSecondaryOnSelection(theme.colors)
      );
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

/**
 * Primary text (#5190). `--text-primary` labels every row, including the
 * selected one (`--bg-active`). Solarized Dark measured 4.11:1 on the sidebar
 * and 3.16:1 on a selected row; Solarized Light 3.64:1 on the sidebar.
 */
describe("primary text contrast (WCAG 2.2 AA, #5190)", () => {
  const surfaces = ["bgPrimary", "sidebarBg", "bgDropdown", "bgHover", "bgActive"] as const;
  for (const theme of BUILT_IN_THEMES) {
    const fg = theme.colors.textPrimary;
    for (const surface of surfaces) {
      const bg = theme.colors[surface];
      it(`${theme.id} textPrimary (${fg}) meets AA on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }

    it(`${theme.id} primary text stays at least as strong as secondary and muted`, () => {
      const bg = theme.colors.bgPrimary;
      const primary = contrastRatio(fg, bg);
      expect(primary).toBeGreaterThanOrEqual(contrastRatio(theme.colors.textSecondary, bg));
      expect(primary).toBeGreaterThanOrEqual(contrastRatio(theme.colors.textMuted, bg));
    });
  }
});

/**
 * Solarized text tokens stay Solarized (#5190). The maintainer decision was to
 * remap the failing text roles *within* the canonical 16-colour palette rather
 * than introduce foreign tones, so both themes stay recognisable.
 */
describe("solarized text tokens are canonical palette colours (#5190)", () => {
  const TEXT_TOKENS = [
    "textPrimary",
    "textSecondary",
    "textSecondaryOnSelection",
    "textMuted",
    "textMutedOnSelection",
  ] as const;
  const canonical = new Set(Object.values(SOLARIZED_PALETTE));
  for (const theme of SOLARIZED_THEMES) {
    for (const token of TEXT_TOKENS) {
      const value = theme.colors[token];
      it(`${theme.id} ${token} (${value}) is a canonical Solarized colour`, () => {
        expect(canonical.has(value.toLowerCase())).toBe(true);
      });
    }
  }
});

/**
 * Text on the accent (#5164). Primary buttons draw 13px/500 `--text-on-accent`
 * labels on `--accent-color` (and `--accent-hover` while hovered), so SC 1.4.3's
 * 4.5:1 applies. White on the old Dark accent measured 3.96:1 (hover 3.03:1),
 * on the Solarized blue 3.68:1. The accents were darkened along their hue.
 */
describe("text on accent (WCAG 2.2 AA, #5164)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const { textOnAccent, accentColor, accentHover } = theme.colors;
    for (const [name, bg] of [
      ["accentColor", accentColor],
      ["accentHover", accentHover],
    ] as const) {
      it(`${theme.id} textOnAccent (${textOnAccent}) meets AA on ${name} (${bg})`, () => {
        expect(contrastRatio(textOnAccent, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }

    it(`${theme.id} hover stays visibly distinct from the base accent`, () => {
      expect(contrastRatio(accentColor, accentHover)).toBeGreaterThanOrEqual(1.2);
    });

    it(`${theme.id} accent indicators still reach 3:1 on their surfaces`, () => {
      // --tab-active-border is var(--accent-color) on the active tab.
      expect(contrastRatio(accentColor, theme.colors.tabActiveBg)).toBeGreaterThanOrEqual(
        UI_COMPONENT_MIN
      );
      expect(
        contrastRatio(theme.colors.focusBorder, theme.colors.bgPrimary)
      ).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
    });
  }
});

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
 * ANSI palettes stay canonical (#5309). The palette paints both foreground and
 * background cells, so #5274's palette-level 3:1 floor also turned ANSI-black
 * backgrounds grey (powerline/Agnoster segments, TUI panels). Text readability
 * is instead enforced per cell at render time by xterm's `minimumContrastRatio`
 * (see `TERMINAL_MIN_CONTRAST_RATIO`), so these tokens must ship as authored.
 */
describe("ansi palettes keep their canonical values (#5309)", () => {
  // [theme, token, canonical value]: every entry #5274 had nudged.
  const canonical: [typeof darkTheme, keyof typeof darkTheme.colors, string][] = [
    [darkTheme, "ansiBlack", "#0f1117"],
    [lightTheme, "ansiWhite", "#fafafa"],
    [lightTheme, "ansiBrightGreen", "#98c379"],
    [lightTheme, "ansiBrightYellow", "#e5c07b"],
    [lightTheme, "ansiBrightBlue", "#61afef"],
    [lightTheme, "ansiBrightMagenta", "#c678dd"],
    [lightTheme, "ansiBrightCyan", "#56b6c2"],
    [lightTheme, "ansiBrightWhite", "#ffffff"],
    [solarizedDarkTheme, "ansiBlack", "#073642"], // base02
    [solarizedDarkTheme, "ansiBrightBlack", "#002b36"], // base03
    [solarizedDarkTheme, "ansiBrightGreen", "#586e75"], // base01
    [solarizedLightTheme, "ansiGreen", "#859900"],
    [solarizedLightTheme, "ansiYellow", "#b58900"],
    [solarizedLightTheme, "ansiCyan", "#2aa198"],
    [solarizedLightTheme, "ansiWhite", "#eee8d5"], // base2
    [solarizedLightTheme, "ansiBrightBlue", "#839496"], // base0
    [solarizedLightTheme, "ansiBrightCyan", "#93a1a1"], // base1
    [solarizedLightTheme, "ansiBrightWhite", "#fdf6e3"], // base3
  ];
  for (const [theme, key, value] of canonical) {
    it(`${theme.id} ${key} is the canonical ${value}`, () => {
      expect(theme.colors[key]).toBe(value);
    });
  }

  const XTERM_ANSI: [string, keyof typeof darkTheme.colors][] = [
    ["black", "ansiBlack"],
    ["red", "ansiRed"],
    ["green", "ansiGreen"],
    ["yellow", "ansiYellow"],
    ["blue", "ansiBlue"],
    ["magenta", "ansiMagenta"],
    ["cyan", "ansiCyan"],
    ["white", "ansiWhite"],
    ["brightBlack", "ansiBrightBlack"],
    ["brightRed", "ansiBrightRed"],
    ["brightGreen", "ansiBrightGreen"],
    ["brightYellow", "ansiBrightYellow"],
    ["brightBlue", "ansiBrightBlue"],
    ["brightMagenta", "ansiBrightMagenta"],
    ["brightCyan", "ansiBrightCyan"],
    ["brightWhite", "ansiBrightWhite"],
  ];
  for (const theme of BUILT_IN_THEMES) {
    it(`${theme.id} reaches xterm with its palette unchanged`, () => {
      applyTheme(theme.id);
      const xterm = getXtermTheme();
      for (const [slot, key] of XTERM_ANSI) {
        expect(xterm[slot], `${theme.id} ${slot}`).toBe(theme.colors[key]);
      }
      applyTheme("dark");
    });
  }

  it("dark: an ANSI-black background cell blends into the terminal background", () => {
    // `ESC[40m` paints xterm's `black`; it must be the terminal surface, or every
    // Agnoster/powerline segment and TUI panel shows a visible block (#5309).
    applyTheme("dark");
    const xterm = getXtermTheme();
    expect(xterm.black).toBe(xterm.background);
    expect(darkTheme.colors.ansiBlack).toBe(darkTheme.colors.terminalBg);
  });

  it("does not rewrite a plugin theme's palette either", () => {
    // A plugin ansiWhite equal to its background stays as authored in the theme;
    // the render-time contrast floor keeps white *text* readable per cell.
    const full: Record<string, string> = {};
    for (const key of COLOR_TOKEN_KEYS) full[key] = "#123456";
    const json = JSON.stringify({
      colorScheme: "light",
      colors: { ...full, terminalBg: "#ffffff", ansiWhite: "#ffffff" },
    });
    const plugin = parsePluginTheme("acme", { id: "paper", name: "Paper", file: "p.json" }, json);
    previewTheme(plugin);
    expect(getXtermTheme().white).toBe("#ffffff");
    applyTheme("dark");
  });

  it("does not rewrite an edited custom theme", () => {
    const custom = createCustomTheme("dark", "Ink");
    custom.colors.ansiBrightBlack = custom.colors.terminalBg;
    previewTheme(custom);
    const xterm = getXtermTheme();
    expect(xterm.brightBlack).toBe(xterm.background);
    applyTheme("dark");
  });
});
