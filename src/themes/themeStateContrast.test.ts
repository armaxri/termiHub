import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { contrastRatio, relativeLuminance } from "./contrast";
import { applyTheme } from "./engine";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import type { ThemeDefinition } from "./types";

/**
 * Selected rows, activity bar, links and switches in every built-in theme
 * (#5853, UI review of product run 20261123T215628Z: R-059, R-115, R-144,
 * R-145, R-146).
 *
 * - R-059: the Solarized Light selected row was a beige band at 1.44:1 on the
 *   cream sidebar; only the left bar marked it. An opaque selection now needs a
 *   row boundary (fill or 1px outline) at the WCAG 1.4.11 minimum of 3:1.
 *   #5888: Dark and Light paint only an accent tint (~1.2:1), so their rows
 *   now carry the accent left bar by default, at 3:1 on sidebar and row.
 * - R-115: Light's hint and empty-state body text (`--text-secondary`) read
 *   weak on the #f3f3f3 sidebar. It now reaches 5.8:1 there.
 * - R-144: Solarized Light's activity bar was dark teal beside a cream sidebar
 *   and editor. Solarized activity bars now follow the theme's light/dark side.
 * - R-145: links sat at exactly 4.50:1. Every built-in link reaches 5:1 on the
 *   surfaces links sit on.
 * - R-146: switches told on from off mainly by colour. The knob reaches 3:1 on
 *   its track in both states, and the on knob carries a check glyph.
 *
 * Also the terminal's OSC 133 command marks (#5563, #5854 R-078): both marks
 * reach 3:1 on the terminal background, and failure differs by shape too.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const UI_COMPONENT_MIN = 3;
const AA_NORMAL_TEXT = 4.5;
/** Links are thin, often 12-13px text: a margin over AA (R-145). */
const LINK_MIN = 5;
/** Light's hint text must read as clearly as the review asked (R-115). */
const LIGHT_HINT_MIN = 5.8;

const BUILT_IN_THEMES: ThemeDefinition[] = [
  darkTheme,
  lightTheme,
  solarizedDarkTheme,
  solarizedLightTheme,
];
const LINK_SURFACES = ["bgPrimary", "bgSecondary", "sidebarBg", "bgDropdown"] as const;

/** CSS with comments stripped. */
function css(file: string): string {
  return readFileSync(join(SRC_DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The declarations of the rule headed exactly by `selector` in `source`. */
function ruleBody(source: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1];
}

describe("links reach 5:1 on every text surface (#5853 R-145)", () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const surface of LINK_SURFACES) {
      const fg = theme.colors.textLink;
      const bg = theme.colors[surface];
      it(`${theme.id} textLink (${fg}) reaches ${LINK_MIN}:1 on ${surface} (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(LINK_MIN);
      });
    }
  }
});

describe("light hint text reads clearly on the sidebar (#5853 R-115)", () => {
  const { colors } = lightTheme;

  it(`textSecondary (${colors.textSecondary}) reaches ${LIGHT_HINT_MIN}:1 on the sidebar`, () => {
    expect(contrastRatio(colors.textSecondary, colors.sidebarBg)).toBeGreaterThanOrEqual(
      LIGHT_HINT_MIN
    );
    expect(contrastRatio(colors.textSecondary, colors.bgSecondary)).toBeGreaterThanOrEqual(
      LIGHT_HINT_MIN
    );
  });

  it("muted text stays the lighter level and still reaches AA", () => {
    expect(contrastRatio(colors.textMuted, colors.sidebarBg)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT
    );
    expect(contrastRatio(colors.textMuted, colors.sidebarBg)).toBeLessThan(
      contrastRatio(colors.textSecondary, colors.sidebarBg)
    );
  });

  it("the empty-state body and the connections hint use the secondary token", () => {
    expect(ruleBody(css("components/ui/ui.css"), ".ui-empty__description")).toMatch(
      /color:\s*var\(--text-secondary\)/
    );
    expect(
      ruleBody(css("components/Sidebar/ConnectionList.css"), ".connections-empty__hint")
    ).toMatch(/color:\s*var\(--text-secondary\)/);
  });
});

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

/** The accent share of an accent-tinted token in `styles/variables.css` (18% -> 0.18). */
function accentTintAlpha(cssVar: string): number {
  const m = new RegExp(
    `${cssVar}:\\s*color-mix\\(in srgb, var\\(--accent-color\\) (\\d+(?:\\.\\d+)?)%, transparent\\)`
  ).exec(css("styles/variables.css"));
  if (!m) throw new Error(`${cssVar} is not an accent color-mix in variables.css`);
  return Number(m[1]) / 100;
}

/**
 * What a theme's selected rows paint on the sidebar and on a `bgSecondary`
 * pane: its opaque `selection` surfaces, or the `variables.css` defaults (the
 * accent tints composited over the surface, an `accentColor` bar, no outline).
 */
function selectedRows(theme: ThemeDefinition) {
  const sel = theme.selection;
  const { sidebarBg, bgSecondary, accentColor } = theme.colors;
  const tinted = (surface: string) => ({
    bg: composite(accentColor, surface, accentTintAlpha("--bg-selected")),
    bgHover: composite(accentColor, surface, accentTintAlpha("--bg-selected-hover")),
  });
  const indicator = sel?.indicator ?? accentColor;
  const outline = sel?.outline;
  return [
    { where: "sidebar", surface: sidebarBg, ...(sel ?? tinted(sidebarBg)), indicator, outline },
    {
      where: "secondary pane",
      surface: bgSecondary,
      ...(sel ? (sel.secondary ?? sel) : tinted(bgSecondary)),
      indicator,
      outline,
    },
  ];
}

describe("every selected row has a 3:1 cue (#5853 R-059, #5888)", () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const row of selectedRows(theme)) {
      const { where, surface, bg, bgHover, indicator, outline } = row;

      it(`${theme.id}: the selected row on the ${where} is bounded at 3:1`, () => {
        // The row's edge against the surface: its fill (resting and hovered)
        // or a 1px outline. Without either, the bar alone must carry the cue.
        const fill = Math.min(contrastRatio(bg, surface), contrastRatio(bgHover, surface));
        const edge = outline ? contrastRatio(outline, surface) : 1;
        const bar = contrastRatio(indicator, surface);
        expect(Math.max(fill, edge, bar)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
      });

      it(`${theme.id}: the bar (${indicator}) reaches 3:1 on the ${where} and on the row`, () => {
        expect(contrastRatio(indicator, surface)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
        if (!theme.selection) {
          // A tint row is a faint band: the bar must also stand out on it.
          expect(contrastRatio(indicator, bg)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
          expect(contrastRatio(indicator, bgHover)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
        }
      });
    }
  }

  it("the tinted themes really are tint-only (the bar is the cue, not the fill)", () => {
    for (const theme of BUILT_IN_THEMES.filter((t) => !t.selection)) {
      const [sidebar] = selectedRows(theme);
      expect(contrastRatio(sidebar.bg, sidebar.surface)).toBeLessThan(UI_COMPONENT_MIN);
    }
  });

  it("the default bar is the accent colour, and themes without a selection keep it", () => {
    expect(css("styles/variables.css")).toMatch(
      /--selected-row-indicator:\s*var\(--accent-color\);/
    );
    const style = document.documentElement.style;
    for (const theme of BUILT_IN_THEMES.filter((t) => !t.selection)) {
      applyTheme(theme.id);
      expect(style.getPropertyValue("--selected-row-indicator")).toBe("");
      expect(style.getPropertyValue("--accent-color")).toBe(theme.colors.accentColor);
    }
  });

  it("the engine writes the outline only for a theme that has one", () => {
    const style = document.documentElement.style;
    applyTheme("solarized-light");
    expect(style.getPropertyValue("--selected-row-outline")).toBe(
      solarizedLightTheme.selection?.outline
    );
    applyTheme("dark");
    expect(style.getPropertyValue("--selected-row-outline")).toBe("");
  });

  it("every selected-row rule paints the shared shadow (bar + outline)", () => {
    const vars = css("styles/variables.css");
    expect(vars).toMatch(/--selected-row-outline:\s*transparent;/);
    expect(vars).toMatch(
      /--selected-row-shadow:\s*inset 2px 0 0 0 var\(--selected-row-indicator\),\s*inset 0 0 0 1px var\(--selected-row-outline\);/
    );
    const rules: [string, string][] = [
      ["components/Sidebar/ConnectionList.css", ".connection-tree__item--selected"],
      ["components/Sidebar/FileBrowser.css", ".file-browser__row-wrapper--selected"],
      ["components/Plugins/Plugins.css", ".plugin-row--selected"],
      ["components/TransferView/TransferView.css", ".transfer-pane__row--selected"],
    ];
    for (const [file, selector] of rules) {
      expect(ruleBody(css(file), selector), `${file} ${selector}`).toMatch(
        /box-shadow:\s*var\(--selected-row-shadow\)/
      );
    }
  });
});

describe("solarized activity bars match the theme's side (#5853 R-144)", () => {
  for (const theme of [solarizedDarkTheme, solarizedLightTheme]) {
    const { activityBarBg, sidebarBg } = theme.colors;
    it(`${theme.id}: the activity bar (${activityBarBg}) is on the sidebar's light/dark side`, () => {
      const isLight = (c: string) => (relativeLuminance(c) ?? 0) > 0.5;
      expect(isLight(activityBarBg)).toBe(isLight(sidebarBg));
      expect(isLight(activityBarBg)).toBe(theme.colorScheme === "light");
    });
  }

  for (const theme of BUILT_IN_THEMES) {
    const { activityBarIndicator, activityBarBg } = theme.colors;
    it(`${theme.id}: the activity-bar indicator reaches 3:1 on the bar`, () => {
      expect(contrastRatio(activityBarIndicator, activityBarBg)).toBeGreaterThanOrEqual(
        UI_COMPONENT_MIN
      );
    });
  }

  it("the item hover/press overlays derive from the icon colour, not a fixed white", () => {
    const vars = css("styles/variables.css");
    expect(vars).toMatch(
      /--activity-bar-item-hover-bg:\s*color-mix\(in srgb, var\(--activity-bar-active\) \d+%, transparent\);/
    );
    expect(vars).toMatch(
      /--activity-bar-item-active-bg:\s*color-mix\(in srgb, var\(--activity-bar-active\) \d+%, transparent\);/
    );
  });
});

describe("switches show on/off without relying on colour (#5853 R-146)", () => {
  for (const theme of BUILT_IN_THEMES) {
    const { colors, controls } = theme;
    // variables.css defaults: off track --bg-active, off knob --text-secondary.
    const offTrack = controls?.toggleOffTrack ?? colors.bgActive;
    const offKnob = controls?.toggleOffThumb ?? colors.textSecondary;

    it(`${theme.id}: the off knob (${offKnob}) reaches 3:1 on its track (${offTrack})`, () => {
      expect(contrastRatio(offKnob, offTrack)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
    });

    it(`${theme.id}: the on knob reaches 3:1 on the accent track`, () => {
      expect(contrastRatio(colors.textOnAccent, colors.accentColor)).toBeGreaterThanOrEqual(
        UI_COMPONENT_MIN
      );
    });

    it(`${theme.id}: the on knob's check glyph reaches 3:1 on the knob`, () => {
      expect(contrastRatio(colors.accentColor, colors.textOnAccent)).toBeGreaterThanOrEqual(
        UI_COMPONENT_MIN
      );
    });
  }

  it("solarized light's off knob gains margin over the 4.13:1 it had", () => {
    const { controls } = solarizedLightTheme;
    expect(contrastRatio(controls!.toggleOffThumb!, controls!.toggleOffTrack!)).toBeGreaterThan(
      4.5
    );
  });

  it("the checked knob draws a check glyph in the accent colour", () => {
    const ui = css("components/ui/ui.css");
    const glyph = ruleBody(ui, '.ui-toggle[data-state="checked"] .ui-toggle__thumb::after');
    expect(glyph).toMatch(/content:\s*""/);
    expect(glyph).toMatch(/border-color:\s*var\(--accent-color\)/);
    expect(ruleBody(ui, ".ui-toggle__thumb")).toMatch(/position:\s*relative/);
  });
});

describe("command marks read on the terminal in every theme (#5563, #5854 R-078)", () => {
  // The success/failure gutter mark is a non-text indicator on the terminal
  // background (WCAG 2.2 SC 1.4.11). #5563 dropped its 75% opacity, which took
  // Dark's failure red to ~3.7:1; #5854 widened it and notched the failure
  // bar, whose thin spine paints the same full-strength token.
  for (const theme of BUILT_IN_THEMES) {
    const bg = theme.colors.terminalBg;
    for (const token of ["colorSuccess", "colorError"] as const) {
      const fg = theme.colors[token];
      it(`${theme.id}: ${token} (${fg}) reaches 3:1 on terminalBg (${bg})`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
      });
    }
  }

  it("the engine writes the status and terminal tokens the marks paint", () => {
    const root = document.documentElement;
    for (const theme of BUILT_IN_THEMES) {
      applyTheme(theme.id);
      expect(root.style.getPropertyValue("--color-success")).toBe(theme.colors.colorSuccess);
      expect(root.style.getPropertyValue("--color-error")).toBe(theme.colors.colorError);
      expect(root.style.getPropertyValue("--terminal-bg")).toBe(theme.colors.terminalBg);
    }
  });

  it("both marks paint the full-strength token with no opacity", () => {
    const terminal = css("components/Terminal/Terminal.css");
    const mark = ".terminal-container .xterm-decoration.terminal-command-mark";
    expect(ruleBody(terminal, mark)).not.toMatch(/opacity/);
    expect(ruleBody(terminal, `${mark}--success`)).toMatch(
      /background-color:\s*var\(--color-success\);/
    );
    expect(ruleBody(terminal, `${mark}--failure`)).toMatch(
      /background-color:\s*var\(--color-error\);/
    );
  });
});
