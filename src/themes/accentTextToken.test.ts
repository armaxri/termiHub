import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname, relative, sep } from "path";
import { fileURLToPath } from "url";
import { contrastRatio } from "./contrast";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";

/**
 * Accent foreground token discipline (#5727, follow-up to #5702).
 *
 * `--accent-color` is the button *fill*: each theme tunes it so the white
 * button label passes on it, which leaves Solarized Dark's blue (#227bba) at
 * 2.5–3.3:1 against its own backgrounds — under AA for text (4.5:1) and, on the
 * sidebar and `bgTertiary`, even under the 3:1 non-text minimum for icons.
 * Foregrounds (`color:`) therefore read `--text-link` (links) or `--text-accent`
 * (accent labels and icons); labels sitting on an accent tint read
 * `--text-primary`, because `--text-accent` misses AA on the tint in Light and
 * both Solarized themes. Fills, borders and outlines stay on `--accent-color`.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const AA_NORMAL_TEXT = 4.5;
const BUILT_IN_THEMES = [darkTheme, lightTheme, solarizedDarkTheme, solarizedLightTheme];
/** The surfaces each theme tunes its text tokens to reach AA on (#5399). */
const TEXT_SURFACES = ["bgPrimary", "bgSecondary", "sidebarBg", "bgDropdown"] as const;
/** WCAG 1.4.11 non-text minimum, for accent icons (e.g. a pressed chip on bgTertiary). */
const UI_COMPONENT_MIN = 3;

/**
 * Selectors allowed to paint `color: var(--accent-color)`, with the reason.
 * Empty today: every foreground use moved to a text token. An entry needs a
 * foreground that is genuinely not text *and* measures ≥3:1 in every theme.
 */
const ALLOWLIST: Record<string, string> = {};

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : cssFiles(path);
    return name.endsWith(".css") ? [path] : [];
  });
}

/** Every `selector { body }` rule in `css`, comments stripped. */
function rules(css: string): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

/** `color:` (not `background-color:` / `border-color:`) reading the accent fill. */
const ACCENT_FOREGROUND = /(^|[\s;{])color:\s*var\(--accent-color\b/;

function accentForegroundRules(): string[] {
  return cssFiles(SRC_DIR).flatMap((file) =>
    rules(readFileSync(file, "utf8"))
      .filter((r) => ACCENT_FOREGROUND.test(r.body))
      .map((r) => `${relative(SRC_DIR, file).split(sep).join("/")} :: ${r.selector}`)
  );
}

describe("foregrounds never read the accent fill token (#5727)", () => {
  it("finds the stylesheets to scan", () => {
    expect(cssFiles(SRC_DIR).length).toBeGreaterThan(50);
  });

  it("detects the pattern (scanner self-check)", () => {
    const sample =
      ".a {\n  color: var(--accent-color);\n}\n.b { border-color: var(--accent-color); }";
    const hits = rules(sample).filter((r) => ACCENT_FOREGROUND.test(r.body));
    expect(hits.map((r) => r.selector)).toEqual([".a"]);
  });

  it("no rule outside the allow-list paints color: var(--accent-color)", () => {
    const offenders = accentForegroundRules().filter((key) => !(key.split(" :: ")[1] in ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still exists (no stale exemptions)", () => {
    const selectors = new Set(accentForegroundRules().map((key) => key.split(" :: ")[1]));
    expect(Object.keys(ALLOWLIST).filter((s) => !selectors.has(s))).toEqual([]);
  });
});

/** [CSS file under src/, selector, the foreground token it must read]. */
const MIGRATED: [string, string, string][] = [
  [
    "components/TunnelEditor/TunnelEditor.css",
    ".tunnel-editor__reachability-action",
    "--text-link",
  ],
  ["components/TunnelSidebar/TunnelSidebar.css", ".tunnel-item__inline-action", "--text-link"],
  ["components/Settings/PluginSettingsSection.css", ".plugin-settings__saved", "--text-accent"],
  ["components/FileEditor/FileEditor.css", ".file-editor__remote-badge", "--text-accent"],
  ["components/LogViewer/LogViewer.css", ".log-viewer__level--INFO", "--text-accent"],
  ["components/WorkflowSidebar/WorkflowSidebar.css", ".workflow-item__armed", "--text-accent"],
  [
    "components/OpenConnections/OpenConnectionsModal.css",
    ".oc-row__badge--managed",
    "--text-primary",
  ],
  [
    "components/AgentVersionBadge/AgentVersionBadge.css",
    ".agent-version-badge__state--updating",
    "--text-primary",
  ],
  [
    "components/WorkspaceEditor/WorkspaceEditor.css",
    ".layout-size-badge--custom",
    "--text-primary",
  ],
];

describe("migrated accent foregrounds read their text token", () => {
  it.each(MIGRATED)("%s %s uses %s", (file, selector, token) => {
    const rule = rules(readFileSync(join(SRC_DIR, file), "utf8")).find(
      (r) => r.selector === selector
    );
    expect(rule, `missing ${selector}`).toBeDefined();
    expect(rule!.body).toMatch(new RegExp(`(^|[\\s;])color:\\s*var\\(${token}\\)`));
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

describe("accent text tokens meet AA in every built-in theme (#5727)", () => {
  for (const theme of BUILT_IN_THEMES) {
    for (const token of ["textAccent", "textLink"] as const) {
      for (const surface of TEXT_SURFACES) {
        const fg = theme.colors[token];
        const bg = theme.colors[surface];
        it(`${theme.id} ${token} (${fg}) reaches 4.5:1 on ${surface} (${bg})`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    }

    it(`${theme.id} textAccent reaches 3:1 as an icon on bgTertiary`, () => {
      expect(
        contrastRatio(theme.colors.textAccent, theme.colors.bgTertiary)
      ).toBeGreaterThanOrEqual(UI_COMPONENT_MIN);
    });

    // The tinted badges mix 10% / 18% accent into the surface beneath them.
    for (const alpha of [0.1, 0.18]) {
      for (const surface of [...TEXT_SURFACES, "bgTertiary"] as const) {
        const bg = composite(theme.colors.accentColor, theme.colors[surface], alpha);
        const fg = theme.colors.textPrimary;
        it(`${theme.id} textPrimary reaches 4.5:1 on a ${alpha * 100}% accent tint over ${surface}`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        });
      }
    }
  }

  it("documents the regression: Solarized Dark's accent fill misses 3:1 on the sidebar", () => {
    const { accentColor, sidebarBg, bgTertiary } = solarizedDarkTheme.colors;
    expect(contrastRatio(accentColor, sidebarBg)).toBeLessThan(UI_COMPONENT_MIN);
    expect(contrastRatio(accentColor, bgTertiary)).toBeLessThan(UI_COMPONENT_MIN);
  });
});
