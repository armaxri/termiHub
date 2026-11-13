import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { contrastRatio } from "./contrast";
import { COLOR_TO_CSS_VAR } from "./engine";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import type { ThemeColors, ThemeDefinition } from "./types";

/**
 * Status text on its own status tint (#5740, follow-up to #5727).
 *
 * Chips, badges and banners paint a status colour as a translucent tint
 * (`color-mix(in srgb, var(--color-error) 18%, transparent)`, `--color-error-bg`,
 * `--bg-warning`). The status colours are tuned to reach AA on the plain
 * surfaces, not on a tint of themselves: Light's success green measures 3.04:1
 * on its 18% tint, Solarized Dark's info blue 3.06:1, the fixed notice amber
 * 1.57:1 in Light. So a label on a status tint reads `--text-primary`; the tint
 * (plus a border or icon where the component has one) carries the status cue —
 * the #5407 / #5727 precedent.
 *
 * This file pins it two ways:
 * 1. a stylesheet scan: no text rule paints a status colour on a status tint,
 *    except icon-only foregrounds that measure ≥3:1 (WCAG 1.4.11);
 * 2. a contrast grade: every tint the stylesheets actually use, over the
 *    surfaces it can sit on, keeps the label it declares at ≥4.5:1 in all four
 *    built-in themes.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const AA_NORMAL_TEXT = 4.5;
const UI_COMPONENT_MIN = 3;
const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];

/** Surfaces a `transparent`-based tint can sit on (the #5399 text surfaces + bgTertiary). */
const TINT_SURFACES = [
  "bgPrimary",
  "bgSecondary",
  "sidebarBg",
  "bgDropdown",
  "bgTertiary",
] as const;

/** Status tokens whose tints this guard covers. */
const STATUS_VARS = [
  "--color-success",
  "--color-warning",
  "--color-error",
  "--color-info",
  "--color-notice",
  "--state-connected",
  "--state-connecting",
  "--state-disconnected",
] as const;

/** Shorthand tint tokens from variables.css: [status var, alpha]. */
const TINT_ALIASES: Record<string, [string, number]> = {
  "--color-error-bg": ["--color-error", 0.12],
  "--bg-warning": ["--color-warning", 0.12],
};

/**
 * Status-coloured foregrounds allowed on a status tint because they paint a
 * glyph, not text — each graded ≥3:1 (WCAG 1.4.11) below. A rule whose last
 * class names an icon (`…__icon`, `…-icon`) is an icon automatically; this
 * list holds the icon-only rules named otherwise, with the reason.
 * Key: `<file under src/> :: <selector>`.
 */
const ICON_ALLOWLIST: Record<string, string> = {
  "components/ui/ui.css :: .ui-connect-progress__badge":
    "icon-only outcome badge (56px glyph); the label sits outside the tint",
  'components/ui/ui.css :: .ui-connect-progress[data-phase="timeout"] .ui-connect-progress__badge':
    "icon-only outcome badge (timeout variant)",
};

/** Whether a pair's foreground paints a glyph (icon), not text. */
function isIcon(pair: Pair): boolean {
  const selector = pair.key.split(" :: ")[1];
  return pair.key in ICON_ALLOWLIST || classes(selector).some((c) => /[-_]icon$/.test(c));
}

const CSS_VAR_TO_KEY = Object.fromEntries(
  Object.entries(COLOR_TO_CSS_VAR).map(([key, cssVar]) => [cssVar, key as keyof ThemeColors])
) as Record<string, keyof ThemeColors>;

/** `--color-notice` is a single `:root` value in variables.css, not a theme token. */
const VARIABLES_CSS = readFileSync(join(SRC_DIR, "styles/variables.css"), "utf8");
function staticVar(name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(VARIABLES_CSS);
  if (!m) throw new Error(`${name} not found in variables.css`);
  return m[1];
}

/** Resolve a CSS custom property to its hex in `theme`. */
function resolve(theme: ThemeDefinition, cssVar: string): string {
  const key = CSS_VAR_TO_KEY[cssVar];
  return key ? theme.colors[key] : staticVar(cssVar);
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every `selector { body }` rule, one entry per selector of a selector list. */
function rules(css: string, file: string): Rule[] {
  const out: Rule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    for (const selector of m[1].split(",")) {
      out.push({ file, selector: selector.trim().replace(/\s+/g, " "), body: m[2] });
    }
  }
  return out;
}

interface Tint {
  status: string;
  alpha: number;
  /** Opaque base surface, or `null` for `transparent` (any surface). */
  base: string | null;
}

const STATUS_ALT = STATUS_VARS.join("|");
const MIX = new RegExp(
  `color-mix\\(in srgb,\\s*var\\((${STATUS_ALT})\\)\\s+(\\d+(?:\\.\\d+)?)%,\\s*(transparent|var\\((--[a-z0-9-]+)\\))\\s*\\)`
);
const ALIAS = new RegExp(`var\\((${Object.keys(TINT_ALIASES).join("|")})\\)`);

/** The status tint a rule's background paints, if any. */
function tintOf(body: string): Tint | null {
  const bg = /(?:^|[\s;])background(?:-color)?:\s*([^;]+)/.exec(body);
  if (!bg) return null;
  const mix = MIX.exec(bg[1]);
  if (mix) return { status: mix[1], alpha: Number(mix[2]) / 100, base: mix[4] ?? null };
  const alias = ALIAS.exec(bg[1]);
  if (alias) {
    const [status, alpha] = TINT_ALIASES[alias[1]];
    return { status, alpha, base: null };
  }
  return null;
}

/** The `var(--x)` a rule's `color:` reads, if it reads one. */
function foregroundVar(body: string): string | null {
  const m = /(?:^|[\s;])color:\s*var\((--[a-z0-9-]+)\)/.exec(body);
  return m ? m[1] : null;
}

function classes(selector: string): string[] {
  return selector.match(/\.[A-Za-z0-9_-]+/g) ?? [];
}

interface Pair {
  key: string;
  tint: Tint;
  fg: string;
}

/**
 * Every (foreground, status tint) pair in the stylesheets. A tint rule's label
 * is its own `color:`, or — when it sets none — the `color:` of a same-file
 * rule that targets exactly one of its classes (the LogViewer level chips set
 * the colour on `--error` and the tint on `--active.--error`). BEM elements of
 * a tinted block (`.block__el` / `.block-el` inside `.block`) are paired too.
 */
function tintPairs(): Pair[] {
  const all = cssFiles(SRC_DIR).flatMap((path) =>
    rules(readFileSync(path, "utf8"), relative(SRC_DIR, path))
  );
  const pairs: Pair[] = [];
  for (const r of all) {
    const tint = tintOf(r.body);
    if (!tint) continue;
    const sameFile = all.filter((o) => o.file === r.file);
    // A rule with the tint's exact selector that sets a colour wins over the
    // colour of a rule that targets only one of its classes.
    const own = sameFile.filter((o) => o.selector === r.selector && foregroundVar(o.body));
    const linked: Rule[] = own.length
      ? own
      : sameFile.filter((o) => classes(r.selector).includes(o.selector) && foregroundVar(o.body));
    const last = classes(r.selector).at(-1);
    const elements = last
      ? sameFile.filter(
          (o) =>
            o !== r &&
            (o.selector.startsWith(`${last}__`) || o.selector.startsWith(`${last}-`)) &&
            foregroundVar(o.body)
        )
      : [];
    for (const o of [...linked, ...elements]) {
      // An element that only restyles the tinted block's own label is still
      // painted over the block's tint; a linked rule's colour is overridden
      // when the tint rule itself sets one.
      pairs.push({ key: `${o.file} :: ${o.selector}`, tint, fg: foregroundVar(o.body)! });
    }
  }
  return pairs;
}

const PAIRS = tintPairs();

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

/** Every opaque colour `tint` can render as in `theme`. */
function tintBackgrounds(theme: ThemeDefinition, tint: Tint): [string, string][] {
  const status = resolve(theme, tint.status);
  const bases = tint.base ? [tint.base] : TINT_SURFACES.map((s) => COLOR_TO_CSS_VAR[s]);
  return bases.map((b) => [b, composite(status, resolve(theme, b), tint.alpha)]);
}

describe("status text never sits on a status tint (#5740)", () => {
  it("finds the tinted chips, badges and banners", () => {
    expect(PAIRS.length).toBeGreaterThan(25);
    const keys = PAIRS.map((p) => p.key);
    expect(keys).toContain(
      "components/AgentVersionBadge/AgentVersionBadge.css :: .agent-version-badge__state--up-to-date"
    );
    expect(keys).toContain(
      "components/LogViewer/LogViewer.css :: .log-viewer__level-filter--active.log-viewer__level-filter--error"
    );
  });

  it("detects the pattern (scanner self-check)", () => {
    const sample = rules(
      ".a { color: var(--color-error); background: color-mix(in srgb, var(--color-error) 18%, transparent); }",
      "x.css"
    );
    expect(tintOf(sample[0].body)).toEqual({ status: "--color-error", alpha: 0.18, base: null });
    expect(foregroundVar(sample[0].body)).toBe("--color-error");
    expect(tintOf("background: var(--bg-warning);")).toEqual({
      status: "--color-warning",
      alpha: 0.12,
      base: null,
    });
  });

  it("no text rule outside the icon allow-list paints a status colour on a status tint", () => {
    const offenders = PAIRS.filter(
      (p) => (STATUS_VARS as readonly string[]).includes(p.fg) && !isIcon(p)
    ).map((p) => `${p.key} (${p.fg} on ${p.tint.status} ${Math.round(p.tint.alpha * 100)}%)`);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("every allow-list entry still exists (no stale exemptions)", () => {
    const keys = new Set(PAIRS.map((p) => p.key));
    expect(Object.keys(ICON_ALLOWLIST).filter((k) => !keys.has(k))).toEqual([]);
  });
});

describe("status tints keep their labels at AA in every built-in theme (#5740)", () => {
  const labelled = PAIRS.filter((p) => !(STATUS_VARS as readonly string[]).includes(p.fg));
  // The tinted labels in scope are the ones this issue moved to --text-primary
  // (plus those that already read it). Other neutrals on a tint are a separate audit.
  const primary = labelled.filter((p) => p.fg === "--text-primary");

  it("grades a representative set of tints", () => {
    expect(primary.length).toBeGreaterThan(20);
  });

  for (const theme of BUILT_IN_THEMES) {
    for (const pair of primary) {
      it(`${theme.id} ${pair.key} reaches 4.5:1 on its ${pair.tint.status} tint`, () => {
        const fg = resolve(theme, pair.fg);
        for (const [base, bg] of tintBackgrounds(theme, pair.tint)) {
          expect(
            contrastRatio(fg, bg),
            `${fg} on ${bg} (${Math.round(pair.tint.alpha * 100)}% over ${base})`
          ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        }
      });
    }

    for (const pair of PAIRS.filter(
      (p) => isIcon(p) && (STATUS_VARS as readonly string[]).includes(p.fg)
    )) {
      it(`${theme.id} icon ${pair.key} reaches 3:1 on its tint`, () => {
        const fg = resolve(theme, pair.fg);
        for (const [base, bg] of tintBackgrounds(theme, pair.tint)) {
          expect(
            contrastRatio(fg, bg),
            `${fg} on ${bg} (${Math.round(pair.tint.alpha * 100)}% over ${base})`
          ).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
        }
      });
    }
  }

  it("documents the regression: status colours miss AA on their own tint", () => {
    const on18 = (theme: ThemeDefinition, cssVar: string) => {
      const fg = resolve(theme, cssVar);
      return contrastRatio(fg, composite(fg, theme.colors.bgSecondary, 0.18));
    };
    expect(on18(lightTheme, "--color-success")).toBeLessThan(AA_NORMAL_TEXT);
    expect(on18(solarizedDarkTheme, "--color-info")).toBeLessThan(AA_NORMAL_TEXT);
    expect(on18(lightTheme, "--color-notice")).toBeLessThan(UI_COMPONENT_MIN);
  });
});
