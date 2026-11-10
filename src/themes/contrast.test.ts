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
import { COLOR_TO_CSS_VAR } from "./engine";
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
