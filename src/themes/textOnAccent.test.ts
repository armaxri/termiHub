import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  deriveTextOnAccent,
  TEXT_ON_ACCENT_DARK,
  TEXT_ON_ACCENT_LIGHT,
} from "./contrast";
import { COLOR_TO_CSS_VAR } from "./engine";
import { createCustomTheme, resolveCustomTheme } from "./customThemes";
import { parsePluginTheme } from "./pluginThemes";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";

/**
 * `--text-on-accent` regression tests (UI2-003, #4356).
 *
 * The foreground drawn on the accent (primary buttons, checked checkboxes,
 * active chips) used to be a static white in variables.css. Custom and plugin
 * themes can pick any accent, so a light accent (yellow, pastel) made every
 * primary button unreadable. It is now a theme token derived from the accent's
 * WCAG contrast whenever a theme does not pin it explicitly.
 */

const AA_NORMAL_TEXT = 4.5;
const LIGHT_ACCENTS = ["#ffd700", "#f5e663", "#a8e6cf", "#ffffff", "#fff"];

describe("deriveTextOnAccent", () => {
  it.each(LIGHT_ACCENTS)("a light accent (%s) gets dark text meeting WCAG AA", (accent) => {
    const fg = deriveTextOnAccent(accent);
    expect(fg).toBe(TEXT_ON_ACCENT_DARK);
    expect(contrastRatio(fg, accent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it.each([darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme])(
    "keeps white on the built-in $id accent",
    (theme) => {
      expect(deriveTextOnAccent(theme.colors.accentColor)).toBe(TEXT_ON_ACCENT_LIGHT);
    }
  );

  it("keeps white on a dark accent", () => {
    expect(deriveTextOnAccent("#1a1a6e")).toBe(TEXT_ON_ACCENT_LIGHT);
  });

  it("falls back to white for a value it cannot parse", () => {
    expect(deriveTextOnAccent("var(--nope)")).toBe(TEXT_ON_ACCENT_LIGHT);
  });
});

describe("textOnAccent theme token", () => {
  it("maps to the --text-on-accent CSS variable", () => {
    expect(COLOR_TO_CSS_VAR.textOnAccent).toBe("--text-on-accent");
  });

  it.each([darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme])(
    "built-in $id declares white on its accent",
    (theme) => {
      expect(theme.colors.textOnAccent).toBe(TEXT_ON_ACCENT_LIGHT);
    }
  );

  it("is not a user-editable token (it is derived from the accent)", () => {
    expect(COLOR_TOKEN_KEYS).not.toContain("textOnAccent");
  });
});

describe("custom themes derive textOnAccent from the accent", () => {
  it("a light accent yields dark on-accent text", () => {
    const custom = createCustomTheme("dark", "Sunny");
    custom.colors.accentColor = "#ffd700";
    const resolved = resolveCustomTheme(custom);
    expect(resolved.colors.textOnAccent).toBe(TEXT_ON_ACCENT_DARK);
    expect(contrastRatio(resolved.colors.textOnAccent, "#ffd700")).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT
    );
  });

  it("ignores a stale white copied from the base theme", () => {
    // createCustomTheme copies every base colour, including textOnAccent; the
    // editor cannot change it, so it must never pin white over a light accent.
    const custom = createCustomTheme("light", "Pastel");
    custom.colors.accentColor = "#a8e6cf";
    custom.colors.textOnAccent = "#ffffff";
    expect(resolveCustomTheme(custom).colors.textOnAccent).toBe(TEXT_ON_ACCENT_DARK);
  });

  it("an unchanged base accent keeps white", () => {
    const custom = createCustomTheme("dark", "Plain");
    expect(resolveCustomTheme(custom).colors.textOnAccent).toBe(TEXT_ON_ACCENT_LIGHT);
  });
});

describe("plugin themes derive textOnAccent when not set", () => {
  function pluginJson(colors: Record<string, string>): string {
    const full: Record<string, string> = {};
    for (const key of COLOR_TOKEN_KEYS) full[key] = "#123456";
    return JSON.stringify({ colorScheme: "light", colors: { ...full, ...colors } });
  }
  const entry = { id: "paper", name: "Paper", file: "paper.json" };

  it("derives dark text for a light accent", () => {
    const theme = parsePluginTheme("acme", entry, pluginJson({ accentColor: "#ffd700" }));
    expect(theme.colors.textOnAccent).toBe(TEXT_ON_ACCENT_DARK);
  });

  it("honours an explicit textOnAccent from the plugin", () => {
    const theme = parsePluginTheme(
      "acme",
      entry,
      pluginJson({ accentColor: "#ffd700", textOnAccent: "#222222" })
    );
    expect(theme.colors.textOnAccent).toBe("#222222");
  });
});
