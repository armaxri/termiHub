/**
 * Per-theme indicator, input-border and focus tokens, and the surfaces the older
 * contrast guards did not cover (#6154; audit UI-013, UI-014, UI-024, UI-025,
 * UI-026). Every built-in theme, WCAG 2.2: 4.5:1 for text (SC 1.4.3), 3:1 for
 * non-text indicators and boundaries (SC 1.4.11).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { contrastRatio } from "./contrast";
import { darkTheme } from "./dark";
import { COLOR_TO_CSS_VAR } from "./engine";
import { lightTheme } from "./light";
import { parsePluginTheme } from "./pluginThemes";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import type { ThemeColors, ThemeDefinition } from "./types";

const TEXT = 4.5;
const NON_TEXT = 3;
const THEMES: ThemeDefinition[] = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `fg` meets `min` on every surface, in every built-in theme. */
function grade(
  what: string,
  fg: keyof ThemeColors,
  surfaces: readonly (keyof ThemeColors)[],
  min: number
): void {
  for (const theme of THEMES) {
    for (const surface of surfaces) {
      const [a, b] = [theme.colors[fg], theme.colors[surface]];
      it(`${theme.id} ${what} ${fg} (${a}) reaches ${min}:1 on ${surface} (${b})`, () => {
        expect(contrastRatio(a, b)).toBeGreaterThanOrEqual(min);
      });
    }
  }
}

describe("text on raised and input surfaces (UI-014)", () => {
  grade("text", "textPrimary", ["bgTertiary", "bgInput"], TEXT);
  grade("text", "textSecondary", ["bgTertiary", "bgInput"], TEXT);
  grade("text", "textMuted", ["bgInput"], TEXT);
  // Muted text on a raised surface switches to its on-selection tone (#5200).
  grade("text", "textMutedOnSelection", ["bgTertiary"], TEXT);
});

describe("state dots where they show (UI-014)", () => {
  const surfaces = ["sidebarBg", "bgSecondary", "tabBg", "tabActiveBg"] as const;
  grade("dot", "stateConnected", surfaces, NON_TEXT);
  grade("dot", "stateConnecting", surfaces, NON_TEXT);
  grade("dot", "stateDisconnected", surfaces, NON_TEXT);
});

describe("notice, broadcast and automation accents per theme (UI-013)", () => {
  // Both also colour status-bar text (the agent update count, the broadcast pill).
  grade("text", "colorNotice", ["bgSecondary"], TEXT);
  grade("text", "broadcastAccent", ["bgSecondary"], TEXT);
  grade("indicator", "colorNotice", ["bgPrimary", "sidebarBg", "bgDropdown"], NON_TEXT);
  grade("ring", "broadcastAccent", ["bgPrimary", "tabBg", "tabActiveBg"], NON_TEXT);
  grade("badge", "macroAccent", ["tabBg", "tabActiveBg"], NON_TEXT);

  it("are theme tokens, written as the CSS variables the styles use", () => {
    expect(COLOR_TO_CSS_VAR.colorNotice).toBe("--color-notice");
    expect(COLOR_TO_CSS_VAR.broadcastAccent).toBe("--broadcast-accent");
    expect(COLOR_TO_CSS_VAR.macroAccent).toBe("--macro-accent");
    expect(COLOR_TO_CSS_VAR.borderInput).toBe("--border-input");
  });
});

describe("the input border (UI-025)", () => {
  grade("boundary", "borderInput", ["bgInput", "bgPrimary", "sidebarBg", "bgDropdown"], NON_TEXT);

  it("draws the border of inputs, selects and text areas", () => {
    const css = readFileSync(join(SRC, "components/ui/ui.css"), "utf8");
    for (const selector of [".ui-input", ".ui-select__trigger", ".ui-textarea"]) {
      const body = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(
        css
      )?.[1];
      expect(body, selector).toBeDefined();
      expect(body, selector).toMatch(/border:[^;]*var\(--border-input\)/);
    }
  });
});

describe("the focus ring (UI-024)", () => {
  grade(
    "ring",
    "focusBorder",
    ["bgPrimary", "bgSecondary", "sidebarBg", "bgTertiary", "bgInput", "bgDropdown"],
    NON_TEXT
  );

  /** The body of the rule for exactly `selector` in `file`. */
  const rule = (file: string, selector: string) => {
    const css = readFileSync(join(SRC, file), "utf8");
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  };

  it("is a 2px outline 2px off the element, so it shows on whatever surface is around it", () => {
    const variables = readFileSync(join(SRC, "styles/variables.css"), "utf8");
    expect(variables).toMatch(/--focus-ring-width:\s*2px;/);
    expect(variables).toMatch(/--focus-ring-offset:\s*2px;/);
    const body = rule("styles/global.css", ":focus-visible");
    expect(body).toMatch(/outline:\s*var\(--focus-ring-width\) solid var\(--focus-border\)/);
    expect(body).toMatch(/outline-offset:\s*var\(--focus-ring-offset\)/);
  });

  it.each([".ui-btn", ".ui-toggle", ".ui-checkbox", ".ui-radio__control", ".ui-radio-card"])(
    "%s takes the outline too; inputs keep their inset ring",
    (selector) => {
      const body = rule("components/ui/ui.css", `${selector}:focus-visible`);
      expect(body).not.toMatch(/outline:\s*none/);
      expect(body).not.toMatch(/--shadow-focus/);
    }
  );
});

describe("disabled controls (UI-026)", () => {
  it("are muted text on a raised surface, not faded with stacked opacity", () => {
    const css = readFileSync(join(SRC, "components/ui/ui.css"), "utf8");
    const rules = [
      ...css.matchAll(/([^{}]*(?::disabled|\[disabled\]|\[data-disabled\])[^{}]*)\{([^}]*)\}/g),
    ].filter(([, selector]) => !/:not\(/.test(selector.split(",").pop() ?? ""));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      expect(body, selector.trim()).not.toMatch(/(^|[\s;])opacity\s*:/);
    }
  });
});

describe("plugin themes without the new tokens (#6154)", () => {
  const entry = { id: "t", name: "T", file: "t.json" };
  const older = (colorScheme: "dark" | "light") => {
    const colors: Record<string, string> = {};
    for (const key of COLOR_TOKEN_KEYS) colors[key] = "#123456";
    for (const key of ["colorNotice", "broadcastAccent", "macroAccent", "borderInput"]) {
      delete colors[key];
    }
    return parsePluginTheme("acme", entry, JSON.stringify({ colorScheme, colors }));
  };

  it("still load, with the built-in values of their colour scheme", () => {
    expect(older("light").colors.colorNotice).toBe(lightTheme.colors.colorNotice);
    expect(older("dark").colors.borderInput).toBe(darkTheme.colors.borderInput);
  });
});

/**
 * The scrollbar thumb against what it sits on (#6167, audit UI-016 b). The
 * track is transparent, so the thumb is composited over the scroller's surface;
 * the result must reach 3:1 against that surface (SC 1.4.11), or a persistent
 * thumb (#3144) reads as no scrollbar at all.
 */
function rgbaOver(color: string, surface: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(color.trim());
  if (!m) return color;
  const alpha = Number(m[4]);
  const bg = /^#([0-9a-f]{6})$/i.exec(surface.trim());
  if (!bg) throw new Error(`surface ${surface} is not #rrggbb`);
  const back = [0, 2, 4].map((i) => parseInt(bg[1].slice(i, i + 2), 16));
  const mixed = [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * alpha + back[k] * (1 - alpha)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

describe("scrollbar thumb on its surfaces (#6167)", () => {
  const surfaces = ["bgPrimary", "bgSecondary", "bgTertiary", "sidebarBg", "terminalBg"] as const;
  for (const theme of THEMES) {
    for (const token of ["scrollbarThumb", "scrollbarThumbHover"] as const) {
      for (const surface of surfaces) {
        const [thumb, bg] = [theme.colors[token], theme.colors[surface]];
        it(`${theme.id} ${token} (${thumb}) reaches 3:1 on ${surface} (${bg})`, () => {
          expect(contrastRatio(rgbaOver(thumb, bg), bg)).toBeGreaterThanOrEqual(NON_TEXT);
        });
      }
    }
  }

  it("composites a translucent colour over its surface (helper self-check)", () => {
    expect(rgbaOver("rgba(255, 255, 255, 0.5)", "#000000")).toBe("#808080");
    expect(rgbaOver("#123456", "#000000")).toBe("#123456");
  });
});
