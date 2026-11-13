import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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

/** sRGB-composite `fg` at `alpha` over the opaque `bg` (what color-mix + transparent paints). */
function composite(fg: string, bg: string, alpha: number): string {
  const ch = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha))
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The accent share of an accent-tinted surface token in `styles/variables.css`
 * (`--bg-selected: color-mix(in srgb, var(--accent-color) 18%, transparent)`
 * yields 0.18), read from the stylesheet so the grade follows the shipped CSS.
 */
function accentTintAlpha(cssVar: string): number {
  const css = readFileSync(join(SRC_DIR, "styles/variables.css"), "utf8");
  const m = new RegExp(
    `${cssVar}:\\s*color-mix\\(in srgb, var\\(--accent-color\\) (\\d+(?:\\.\\d+)?)%, transparent\\)`
  ).exec(css);
  if (!m) throw new Error(`${cssVar} is not an accent color-mix in variables.css`);
  return Number(m[1]) / 100;
}

const BG_SELECTED_ALPHA = accentTintAlpha("--bg-selected");
const BG_SELECTED_HOVER_ALPHA = accentTintAlpha("--bg-selected-hover");

/**
 * The share of `hue` in an opaque banner surface token in `styles/variables.css`
 * (`--bg-banner-warning: color-mix(in srgb, var(--color-warning) 4%,
 * var(--bg-secondary))` yields 0.04), read from the stylesheet so the grade
 * follows the shipped CSS.
 */
function bannerTintAlpha(cssVar: string, hue: string): number {
  const css = readFileSync(join(SRC_DIR, "styles/variables.css"), "utf8");
  const m = new RegExp(
    `${cssVar}:\\s*color-mix\\(in srgb, var\\(${hue}\\) (\\d+(?:\\.\\d+)?)%, var\\(--bg-secondary\\)\\)`
  ).exec(css);
  if (!m) throw new Error(`${cssVar} is not a ${hue} mix over --bg-secondary in variables.css`);
  return Number(m[1]) / 100;
}

/**
 * App-level bottom banners (#5547): the crash notice (warning surface) and the
 * file-manager prompt (info surface) paint their subtitle and ghost buttons in
 * `--text-secondary`, which each banner redirects to
 * `--text-secondary-on-selection`. Plain `--text-secondary` measured ~4.1:1 on
 * the former 10% warm tint and 4.4:1 on the 10% accent tint.
 */
describe("bottom banner text contrast (WCAG 2.2 AA, #5547)", () => {
  const surfaces = [
    ["--bg-banner-warning", "--color-warning", "colorWarning"],
    ["--bg-banner-info", "--accent-color", "accentColor"],
  ] as const;

  for (const theme of BUILT_IN_THEMES) {
    for (const [cssVar, hue, hueKey] of surfaces) {
      const bg = composite(
        theme.colors[hueKey],
        theme.colors.bgSecondary,
        bannerTintAlpha(cssVar, hue)
      );
      for (const token of ["textPrimary", "textSecondaryOnSelection"] as const) {
        const fg = theme.colors[token];
        it(`${theme.id} ${token} (${fg}) meets AA on ${cssVar} (${bg})`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
      // The amber icon (with the amber top border) is what marks the crash
      // notice as a warning, so it must read as a graphic (1.4.11). The info
      // banner's folder icon is decorative; its text carries the meaning.
      if (hueKey === "colorWarning") {
        it(`${theme.id} warning icon reaches 3:1 on ${cssVar} (${bg})`, () => {
          expect(contrastRatio(theme.colors[hueKey], bg)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
        });
      }
    }
  }

  it.each([
    ["components/Diagnostics/Diagnostics.css", ".crash-report-notice"],
    ["components/ShellIntegrationBanner/ShellIntegrationBanner.css", ".shell-integration-banner"],
  ])("%s redirects --text-secondary on %s", (file, selector) => {
    const css = readFileSync(join(SRC_DIR, file), "utf8");
    const block = new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css);
    expect(block?.[1]).toMatch(/--text-secondary:\s*var\(--text-secondary-on-selection\)/);
  });
});

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

/**
 * Text on accent-tinted selected rows (#5398). `--bg-selected` is
 * `color-mix(in srgb, var(--accent-color) 18%, transparent)`, so the row the
 * user sees is 18% accent composited over whatever sits behind it: the sidebar
 * (connection tree, file-browser drop targets) or the transfer view
 * (`bgSecondary` panes on a `bgPrimary` view). Plain `textSecondary` /
 * `textMuted` fall below AA there; those rows redirect both to the
 * `*-on-selection` tokens (pinned by src/styles/selectedOnSelection.test.ts),
 * and this grades the tokens on the blended surface in all four themes.
 */
describe("text on accent-tinted --bg-selected rows (WCAG 2.2 AA, #5398)", () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const base of ["sidebarBg", "bgSecondary", "bgPrimary"] as const) {
      const bg = composite(theme.colors.accentColor, theme.colors[base], BG_SELECTED_ALPHA);
      for (const token of ["textSecondaryOnSelection", "textMutedOnSelection"] as const) {
        const fg = theme.colors[token];
        it(`${theme.id} ${token} (${fg}) meets AA on --bg-selected over ${base} (${bg})`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    }
  }

  it("documents the gap the redirect closes: plain secondary/muted fail on the sidebar", () => {
    for (const theme of [darkTheme, lightTheme, solarizedDarkTheme]) {
      const bg = composite(theme.colors.accentColor, theme.colors.sidebarBg, BG_SELECTED_ALPHA);
      const worst = Math.min(
        contrastRatio(theme.colors.textSecondary, bg),
        contrastRatio(theme.colors.textMuted, bg)
      );
      expect(worst).toBeLessThan(AA_NORMAL_TEXT);
    }
  });
});

/**
 * Text on hovered selected rows (#5406). `.connection-tree__item--selected:hover`
 * and `.transfer-pane__row--selected:hover` paint `--bg-selected-hover` and keep
 * the #5398 redirect to the `*-on-selection` tokens. The old 28% tint measured
 * Dark 4.00:1 and Light 3.95:1 over the sidebar; no tint stronger than 18%
 * reaches AA there, so hover lightens the tint instead. Graded on the blend read
 * from `variables.css`, over every base the hovered rows sit on.
 */
describe("text on hovered --bg-selected-hover rows (WCAG 2.2 AA, #5406)", () => {
  const BASES = ["sidebarBg", "bgSecondary", "bgPrimary"] as const;
  const TOKENS = ["textSecondaryOnSelection", "textMutedOnSelection"] as const;

  for (const theme of BUILT_IN_THEMES) {
    for (const base of BASES) {
      const bg = composite(theme.colors.accentColor, theme.colors[base], BG_SELECTED_HOVER_ALPHA);
      for (const token of TOKENS) {
        const fg = theme.colors[token];
        it(`${theme.id} ${token} (${fg}) meets AA on --bg-selected-hover over ${base} (${bg})`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    }

    it(`${theme.id} hovered selected row stays visibly distinct from the selected row`, () => {
      const base = theme.colors.sidebarBg;
      const selected = composite(theme.colors.accentColor, base, BG_SELECTED_ALPHA);
      const hovered = composite(theme.colors.accentColor, base, BG_SELECTED_HOVER_ALPHA);
      expect(contrastRatio(selected, hovered)).toBeGreaterThanOrEqual(1.05);
    });
  }

  it("documents the gap: the old 28% tint fails in Dark and Light", () => {
    for (const theme of [darkTheme, lightTheme]) {
      const bg = composite(theme.colors.accentColor, theme.colors.sidebarBg, 0.28);
      const worst = Math.min(...TOKENS.map((token) => contrastRatio(theme.colors[token], bg)));
      expect(worst).toBeLessThan(AA_NORMAL_TEXT);
    }
  });
});

/**
 * Network-panel info banner (#5407). `.network-panel__info` paints
 * `--bg-selected` (18% accent) with an accent left border. Its old
 * `--text-accent` text measured Light 4.15:1, Solarized Dark 3.35:1 and
 * Solarized Light 2.73:1 over `bgPrimary`; it now uses `--text-primary`.
 */
describe("network-panel info banner text (WCAG 2.2 AA, #5407)", () => {
  const bannerRule = (): string => {
    const css = readFileSync(join(SRC_DIR, "components/NetworkTools/NetworkTools.css"), "utf8");
    const body = /\.network-panel__info\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ""));
    if (!body) throw new Error("missing .network-panel__info rule");
    return body[1];
  };

  it("paints --bg-selected and colours its text --text-primary", () => {
    const body = bannerRule();
    expect(body).toMatch(/background(-color)?:\s*var\(--bg-selected\)/);
    expect(body).toMatch(/(^|[\s;])color:\s*var\(--text-primary\)/);
  });

  for (const theme of BUILT_IN_THEMES) {
    for (const base of ["bgPrimary", "sidebarBg", "bgSecondary"] as const) {
      const bg = composite(theme.colors.accentColor, theme.colors[base], BG_SELECTED_ALPHA);
      const fg = theme.colors.textPrimary;
      it(`${theme.id} textPrimary (${fg}) meets AA on --bg-selected over ${base} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("documents the gap: textAccent fails on the banner in Light and both Solarized", () => {
    for (const theme of [lightTheme, solarizedDarkTheme, solarizedLightTheme]) {
      const bg = composite(theme.colors.accentColor, theme.colors.bgPrimary, BG_SELECTED_ALPHA);
      expect(contrastRatio(theme.colors.textAccent, bg)).toBeLessThan(AA_NORMAL_TEXT);
    }
  });
});

/**
 * Solarized link and status colours (#5399). Within the canonical palette no
 * blue/red/yellow/green reaches AA on the Solarized surfaces (e.g. blue 3.53:1
 * on the Dark sidebar, 3.00:1 on Light's base2). The maintainer decision was a
 * minimal off-palette lightness tweak keeping the hue: each token is the
 * canonical colour mixed towards white (Dark) or black (Light) in 1% steps
 * until it reaches 4.5:1 on every text surface (3:1 for dots and the focus
 * ring). Each token is pinned to exactly that derivation, so it stays minimal.
 */
describe("solarized link and status colours (WCAG 2.2 AA, #5399)", () => {
  const TEXT_SURFACES = ["bgPrimary", "bgSecondary", "sidebarBg", "bgDropdown"] as const;
  const DOT_SURFACES = ["bgPrimary", "bgSecondary", "sidebarBg"] as const;
  const FOCUS_SURFACES = ["bgPrimary", "bgTertiary"] as const;
  type Key = keyof typeof solarizedDarkTheme.colors;
  // [token, canonical hue, minimum ratio, surfaces]
  const ROLES: [Key, string, number, readonly Key[]][] = [
    ["textLink", SOLARIZED_PALETTE.blue, AA_NORMAL_TEXT, TEXT_SURFACES],
    ["textAccent", SOLARIZED_PALETTE.blue, AA_NORMAL_TEXT, TEXT_SURFACES],
    ["colorInfo", SOLARIZED_PALETTE.blue, AA_NORMAL_TEXT, TEXT_SURFACES],
    ["colorError", SOLARIZED_PALETTE.red, AA_NORMAL_TEXT, TEXT_SURFACES],
    ["colorWarning", SOLARIZED_PALETTE.yellow, AA_NORMAL_TEXT, TEXT_SURFACES],
    ["colorSuccess", SOLARIZED_PALETTE.green, AA_NORMAL_TEXT, TEXT_SURFACES],
    ["stateConnected", SOLARIZED_PALETTE.green, UI_COMPONENT_MIN, DOT_SURFACES],
    ["stateConnecting", SOLARIZED_PALETTE.yellow, UI_COMPONENT_MIN, DOT_SURFACES],
    ["stateDisconnected", SOLARIZED_PALETTE.red, UI_COMPONENT_MIN, DOT_SURFACES],
    ["focusBorder", SOLARIZED_PALETTE.blue, UI_COMPONENT_MIN, FOCUS_SURFACES],
  ];

  /** HSL hue in degrees of a `#rrggbb` colour. */
  const hue = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  for (const theme of SOLARIZED_THEMES) {
    for (const [token, canonical, min, surfaces] of ROLES) {
      const fg = theme.colors[token];
      const bgs = surfaces.map((s) => theme.colors[s]);

      for (const surface of surfaces) {
        const bg = theme.colors[surface];
        it(`${theme.id} ${token} (${fg}) reaches ${min}:1 on ${surface} (${bg})`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
        });
      }

      it(`${theme.id} ${token} is the minimal hue-keeping nudge of ${canonical}`, () => {
        expect(fg).toBe(adjustForContrast(canonical, bgs, min, 1));
        expect(Math.abs(hue(fg) - hue(canonical))).toBeLessThanOrEqual(1);
      });
    }
  }

  it("documents the gap: the canonical colours fail on the Solarized surfaces", () => {
    const worst = (theme: typeof solarizedDarkTheme, canonical: string) =>
      Math.min(...TEXT_SURFACES.map((s) => contrastRatio(canonical, theme.colors[s])));
    for (const theme of SOLARIZED_THEMES) {
      for (const hueName of ["blue", "red", "yellow", "green"]) {
        expect(worst(theme, SOLARIZED_PALETTE[hueName])).toBeLessThan(AA_NORMAL_TEXT);
      }
    }
  });
});

/**
 * Solarized Light sidebar (#5457). On base2 the three text levels had to
 * collapse to near-black to pass AA; the sidebar now uses base3 like the
 * editor, stays inside the canonical palette, and its text levels pass AA and
 * keep their order. The panel border still separates sidebar and editor.
 */
describe("solarized light sidebar on base3 (#5457)", () => {
  const { colors } = solarizedLightTheme;

  it("sidebar and its header are base3", () => {
    expect(colors.sidebarBg).toBe(SOLARIZED_PALETTE.base3);
    expect(colors.sidebarHeaderBg).toBe(SOLARIZED_PALETTE.base3);
  });

  it("primary, secondary and muted text pass AA on the sidebar, in order", () => {
    const [primary, secondary, muted] = [
      colors.textPrimary,
      colors.textSecondary,
      colors.textMuted,
    ].map((fg) => contrastRatio(fg, colors.sidebarBg));
    expect(muted).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(secondary).toBeGreaterThan(muted);
    expect(primary).toBeGreaterThan(secondary);
  });

  it("selected and hovered rows stay distinct from the sidebar", () => {
    for (const row of [
      colors.bgHover,
      colors.bgActive,
      composite(colors.accentColor, colors.sidebarBg, BG_SELECTED_ALPHA),
    ]) {
      expect(contrastRatio(row, colors.sidebarBg)).toBeGreaterThanOrEqual(1.05);
    }
  });

  it("the panel border separates the sidebar from the editor", () => {
    expect(contrastRatio(colors.borderPrimary, colors.sidebarBg)).toBeGreaterThanOrEqual(1.3);
  });
});

/**
 * Solarized Light muted text (#5459). Maintainer decision: the canonical
 * mapping, base01 for muted, base02 for secondary. base01 reaches 4.99:1 on
 * base3 (editor, sidebar, menus) but only 4.39:1 on base2 (`bgSecondary`) and
 * 3.92:1 on `bgTertiary`, so the surfaces that paint those behind muted text
 * redirect it to `--text-muted-on-selection` (pinned by
 * src/styles/mutedOnSelection.test.ts). That token is graded here on every
 * such surface in all four themes.
 */
describe("solarized light muted text is base01 (#5459)", () => {
  const { colors } = solarizedLightTheme;

  it("muted is base01 and secondary stays base02", () => {
    expect(colors.textMuted).toBe(SOLARIZED_PALETTE.base01);
    expect(colors.textSecondary).toBe(SOLARIZED_PALETTE.base02);
  });

  it("documents the gap the chrome redirect closes: base01 fails on base2 and bgTertiary", () => {
    expect(contrastRatio(colors.textMuted, colors.bgSecondary)).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrastRatio(colors.textMuted, colors.bgTertiary)).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe("muted text on raised chrome surfaces (WCAG 2.2 AA, #5459)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const fg = theme.colors.textMutedOnSelection;
    const surfaces: [string, string][] = [
      ["bgSecondary", theme.colors.bgSecondary],
      ["bgTertiary", theme.colors.bgTertiary],
      // Terminal reconnect strip: 12% warning over the terminal background.
      ["reconnect strip", composite(theme.colors.colorWarning, theme.colors.terminalBg, 0.12)],
    ];
    for (const [name, bg] of surfaces) {
      it(`${theme.id} textMutedOnSelection (${fg}) meets AA on ${name} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      });
    }
  }

  it("muted still marks the unfocused active tab (3:1 on tabBg)", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(contrastRatio(theme.colors.textMuted, theme.colors.tabBg)).toBeGreaterThanOrEqual(
        UI_COMPONENT_MIN
      );
    }
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
