import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname, sep } from "path";
import { fileURLToPath } from "url";

/**
 * Token-discipline regression test (UI Modernization Phase 1, #1059).
 *
 * Guards the design-token layer against regressions introduced during token
 * hardening: no ad-hoc dark-scrim overlays, no hardcoded white foreground
 * (which breaks the light theme), and no per-component scrollbar suppression
 * that fights the global "one scrollbar" rule.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMPONENTS_DIR = join(SRC_DIR, "components");
const THEMES_DIR = join(SRC_DIR, "themes");
const STYLES_DIR = join(SRC_DIR, "styles");

/** Absolute path of the shared primitive layer, excluded from most guards. */
const UI_DIR = join(COMPONENTS_DIR, "ui");

/**
 * Recursively collect files under `dir` whose name passes `match`.
 *
 * @param dir Absolute directory to walk.
 * @param match Predicate on the file's basename.
 * @param skipDir Optional absolute directory subtree to skip entirely.
 * @returns Absolute paths of all matching files found.
 */
function collectFiles(dir: string, match: (name: string) => boolean, skipDir?: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (skipDir && full === skipDir) continue;
      out.push(...collectFiles(full, match, skipDir));
    } else if (match(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Recursively collect every `*.css` file under the components tree.
 *
 * @param dir Absolute directory to walk.
 * @returns Absolute paths of all `.css` files found.
 */
function collectCssFiles(dir: string): string[] {
  return collectFiles(dir, (name) => name.endsWith(".css"));
}

const cssFiles = collectCssFiles(COMPONENTS_DIR);

/** Normalize an absolute path to POSIX separators for allowlist matching. */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Documented allowlist of files permitted to contain a bare `#fff`/`#ffffff`.
 *
 * Empty by design: every hardcoded white in the component CSS was replaced by
 * a token during #1059. Add an entry here only with a written justification in
 * the final report if a genuinely token-less pure-white case is reintroduced.
 */
const WHITE_ALLOWLIST: string[] = [];

/**
 * Shrinking ratchet: files still carrying a bespoke `__btn` class instead of the
 * shared `Button` primitive (src/components/ui/Button.tsx).
 *
 * This list is deliberately over-permissive, never asserted to be free of stale
 * entries, and MUST shrink toward empty: as each area migrates onto the `Button`
 * primitive (tracked by follow-up issues), its entry is removed here. The guard's
 * value is the ratchet — a currently-clean file that reintroduces `__btn` FAILS.
 *
 * ConnectionEditor / TunnelEditor / WorkspaceEditor (migrated in #1085/#1094),
 * the Settings / NetworkTools panels / FileBrowser / TerminalSearchBar /
 * UpdateNotification buttons (migrated in #1096), and the NetworkToolsSidebar
 * (migrated in #1109) were all moved onto the `Button` primitive and removed
 * from this list, which is now empty. Do NOT assert this list has no stale
 * entries — that would cause cross-PR breakage.
 *
 * Paths are repo-relative suffixes (POSIX separators), matched with `endsWith`.
 */
const BESPOKE_BTN_ALLOWLIST: string[] = [];

/**
 * Documented allowlist of component CSS files permitted to carry a standalone
 * raw hex literal.
 *
 * Empty by design: the only standalone raw-hex usages (the StatusBar update /
 * develop-badge indicators and the UpdateNotification amber dot) were migrated to
 * `--color-notice` / `--color-badge-dev` tokens in #1083. `var(--token, #hex)`
 * fallbacks are exempt from the guard (see the raw-hex ratchet test) and do not
 * belong here. Add an entry only with a written justification if a genuinely
 * token-less raw hex is reintroduced.
 */
const RAW_HEX_CSS_ALLOWLIST: string[] = [];

/**
 * Blank out `/* … *\/` comment bodies, keeping the newlines they spanned.
 *
 * These guards check CSS, not prose: an issue reference in a comment (`#1366`)
 * is indistinguishable from a hex colour to a bare regex, so comments are
 * removed before any pattern runs (#1563). Newlines are preserved so the
 * line-based rules keep the file's line structure — a declaration sharing a
 * line with a comment must still be seen.
 *
 * @param css Contents of a CSS file.
 * @returns The same CSS with every comment body replaced by blanks.
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * True when `css` carries a standalone raw hex colour literal.
 *
 * `var(--token, #hex)` fallbacks are acceptable defensive defaults and are
 * exempt: any line whose hex sits inside a `var(...)` fallback is ignored.
 * Comments are ignored entirely (see `stripCssComments`).
 *
 * @param css Contents of a CSS file.
 * @returns Whether any line declares a bare raw hex literal.
 */
function hasStandaloneRawHex(css: string): boolean {
  // A line is exempt when its hex appears inside a var() fallback, e.g.
  // `color: var(--color-error, #f44336);`.
  const varFallbackRe = /var\([^)]*#[0-9a-f]/i;
  const rawHexRe = /#[0-9a-f]{3,8}\b/i;
  return stripCssComments(css)
    .split("\n")
    .some((line) => !varFallbackRe.test(line) && rawHexRe.test(line));
}

/**
 * True when `css` uses a raw `px` value in a `padding` / `margin` / `gap` /
 * `row-gap` / `column-gap` declaration that is NOT on the `--spacing-*` scale
 * (UI-009, #2898).
 *
 * The `--spacing-*` scale in variables.css is the single source of spacing
 * truth; component CSS must reference a token rather than a raw px. Two
 * carve-outs, mirroring the font-size guard:
 *  - a px inside a `var(--token, <fallback>)` is an acceptable defensive default
 *    and is ignored (the whole `var(...)` group is blanked before scanning), and
 *  - `1px` (and `-1px`) is a hairline/nudge, not a spacing step, and is exempt —
 *    it is the CSS analogue of a 1px border and never maps onto the scale.
 *
 * Any other raw px (`6px`, `10px`, `3px`, …) in these properties is an off-scale
 * spacing value and returns true. Only the physical box properties are scanned;
 * positional offsets (`top`/`left`/`inset`) are not spacing-scale members.
 *
 * @param css Contents of a CSS file.
 * @returns Whether any spacing declaration carries an off-scale raw px value.
 */
function hasOffScaleSpacingPx(css: string): boolean {
  const declRe =
    /(?:^|[;{}\s])(?:(?:padding|margin)(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap)\s*:\s*([^;{}]*)/gi;
  for (const m of stripCssComments(css).matchAll(declRe)) {
    // Blank out var(...) groups so a px in a `var(--token, 12px)` fallback is exempt.
    const value = m[1].replace(/var\([^)]*\)/g, " ");
    for (const px of value.matchAll(/(-?\d+)px/gi)) {
      if (Math.abs(Number(px[1])) === 1) continue; // 1px hairline/nudge — not a scale step
      return true;
    }
  }
  return false;
}

describe("CSS token discipline (#1059)", () => {
  it("finds component CSS files to scan", () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it("has no ad-hoc rgba(0, 0, 0, 0.7) overlay scrims", () => {
    const offenders: string[] = [];
    // Matches rgba(0,0,0,0.7) with any internal whitespace.
    const overlayRe = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.7\s*\)/i;
    for (const file of cssFiles) {
      if (overlayRe.test(stripCssComments(readFileSync(file, "utf8")))) {
        offenders.push(file);
      }
    }
    expect(offenders, `Use var(--overlay-bg) instead in: ${offenders.join(", ")}`).toEqual([]);
  });

  it("has no bare #ffffff / #fff literals", () => {
    const offenders: string[] = [];
    const whiteRe = /#fff\b|#ffffff\b/i;
    for (const file of cssFiles) {
      if (WHITE_ALLOWLIST.some((allowed) => file.endsWith(allowed))) {
        continue;
      }
      if (whiteRe.test(stripCssComments(readFileSync(file, "utf8")))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Use var(--text-on-accent) or the correct text token instead in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("does not suppress the global scrollbar in TabGroupChips.css", () => {
    const tabGroupChips = cssFiles.find((f) => f.endsWith("TabGroupChips.css"));
    expect(tabGroupChips, "TabGroupChips.css should exist").toBeDefined();
    const contents = readFileSync(tabGroupChips as string, "utf8");
    expect(contents).not.toMatch(/scrollbar-width:\s*none/i);
    expect(contents).not.toMatch(/-webkit-scrollbar\s*\{\s*display:\s*none/i);
  });
});

/**
 * Components that may hide or re-style a scrollbar, each a named exception
 * documented in the ui-modernization concept's "One scrollbar" rule (#4585).
 * Adding an entry here requires recording the exception and its reason there.
 *
 * - Terminal.css: the terminal draws its own gutter scrollbar
 *   (terminalScrollbar.ts) so the bar stays put in horizontal-scroll mode; the
 *   native xterm viewport bar is hidden to avoid a second vertical bar, and the
 *   horizontal bar's height is pinned to the bottom reserve FitAddon accounts for.
 */
const SCROLLBAR_OVERRIDE_ALLOWLIST: string[] = ["components/Terminal/Terminal.css"];

/** Scrollbar declarations/selectors a component must not use outside the allowlist. */
const SCROLLBAR_OVERRIDE_PATTERNS: RegExp[] = [
  /scrollbar-width\s*:\s*none/i,
  /::-webkit-scrollbar/i,
  /scrollbar-color\s*:/i,
];

describe("one scrollbar (#4585)", () => {
  it("no component hides or re-styles the scrollbar outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of cssFiles) {
      if (SCROLLBAR_OVERRIDE_ALLOWLIST.some((allowed) => toPosix(file).endsWith(allowed))) {
        continue;
      }
      const css = stripCssComments(readFileSync(file, "utf8"));
      if (SCROLLBAR_OVERRIDE_PATTERNS.some((re) => re.test(css))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `Scrollbars are styled globally in global.css; remove the override or document a ` +
        `named exception in the ui-modernization concept and SCROLLBAR_OVERRIDE_ALLOWLIST: ` +
        offenders.join(", ")
    ).toEqual([]);
  });

  it("every allowlisted file still exists (no stale exceptions)", () => {
    for (const allowed of SCROLLBAR_OVERRIDE_ALLOWLIST) {
      expect(
        cssFiles.some((f) => toPosix(f).endsWith(allowed)),
        `${allowed} is allowlisted but no longer exists`
      ).toBe(true);
    }
  });

  it("the terminal's gutter thumb is persistently visible, not auto-hidden (#3144)", () => {
    const terminalCss = cssFiles.find((f) =>
      toPosix(f).endsWith("components/Terminal/Terminal.css")
    );
    expect(terminalCss, "Terminal.css should exist").toBeDefined();
    const css = stripCssComments(readFileSync(terminalCss as string, "utf8"));
    const thumbRule = /\.terminal-vscroll-thumb\s*\{([^}]*)\}/.exec(css);
    expect(thumbRule, ".terminal-vscroll-thumb rule should exist").not.toBeNull();
    const body = (thumbRule as RegExpExecArray)[1];
    expect(body).toMatch(/background-color:\s*var\(--scrollbar-thumb\)/);
    expect(body).not.toMatch(/opacity:\s*0\b/);
    // The horizontal-scroll thumb must not be made transparent at rest either.
    expect(css).not.toMatch(/::-webkit-scrollbar-thumb\s*\{[^}]*transparent/);
  });
});

/**
 * Persistent-scrollbar guard (#3144).
 *
 * The global scrollbar was originally "subtle, auto-hide" (#1045): the thumb was
 * `transparent` at rest and only revealed on hover/focus of the scroll host. On
 * Windows this read as "no scrollbar", making scrolling very hard. The maintainer
 * decision is a thumb that is persistently visible on ALL platforms (still
 * brightening on direct thumb hover). These guards pin that behavior so it cannot
 * silently regress back to auto-hide.
 */
describe("persistent scrollbar (#3144)", () => {
  const globalCss = stripCssComments(readFileSync(join(STYLES_DIR, "global.css"), "utf8"));

  it("shows the webkit thumb at rest via the token, not transparent", () => {
    // The `::-webkit-scrollbar-thumb` (non-hover) rule must paint the thumb with
    // the scrollbar-thumb token, never `background: transparent`.
    const thumbRule = /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--scrollbar-thumb\)/;
    expect(
      thumbRule.test(globalCss),
      "the resting ::-webkit-scrollbar-thumb must use var(--scrollbar-thumb)"
    ).toBe(true);
    expect(
      /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/.test(globalCss),
      "the resting ::-webkit-scrollbar-thumb must not be transparent"
    ).toBe(false);
  });

  it("shows the Firefox thumb at rest and drops the host-hover reveal", () => {
    // The `*` rule sets the standard scrollbar-color to the visible thumb token.
    expect(
      /\*\s*\{[^}]*scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-bg\)/.test(
        globalCss
      ),
      "the `*` rule must default scrollbar-color to the visible thumb token"
    ).toBe(true);
    // The obsolete host-hover reveal selectors must be gone.
    expect(
      /:hover::-webkit-scrollbar-thumb\b/.test(globalCss),
      "the host-hover reveal selector must be removed"
    ).toBe(false);
    expect(
      /:focus-within::-webkit-scrollbar-thumb\b/.test(globalCss),
      "the host-focus reveal selector must be removed"
    ).toBe(false);
  });

  it("keeps a brighten-on-hover affordance on direct thumb hover", () => {
    expect(
      /::-webkit-scrollbar-thumb:hover\s*\{[^}]*background:\s*var\(--scrollbar-thumb-hover\)/.test(
        globalCss
      ),
      "direct thumb hover must use var(--scrollbar-thumb-hover)"
    ).toBe(true);
  });
});

describe("Design-system regression guards (#1083)", () => {
  /**
   * (3a) Dialogs must compose from the `Modal` primitive
   * (src/components/ui/Modal.tsx), which is the single sanctioned wrapper over
   * `@radix-ui/react-dialog`. No component OUTSIDE the primitive layer may import
   * the Radix dialog directly. Clean today (empty offender set expected).
   */
  it("has no direct @radix-ui/react-dialog imports outside the ui/ primitives", () => {
    const sourceFiles = collectFiles(
      COMPONENTS_DIR,
      (name) => name.endsWith(".tsx") || name.endsWith(".ts"),
      UI_DIR
    );
    const importRe = /@radix-ui\/react-dialog/;
    const offenders = sourceFiles
      .filter((file) => importRe.test(readFileSync(file, "utf8")))
      .map(toPosix);
    expect(
      offenders,
      "Dialogs must compose from the Modal primitive (src/components/ui/Modal.tsx); " +
        `do not import @radix-ui/react-dialog directly in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  /**
   * (3b) Bespoke `__btn` ratchet. A currently-clean file that introduces a
   * `__btn` class instead of the shared `Button` primitive FAILS. Known
   * offenders live in BESPOKE_BTN_ALLOWLIST (a shrinking ratchet — see its
   * doc comment).
   */
  it("introduces no new bespoke __btn classes outside the allowlist", () => {
    const files = collectFiles(
      COMPONENTS_DIR,
      (name) => (name.endsWith(".tsx") || name.endsWith(".css")) && !name.endsWith(".test.tsx"),
      UI_DIR
    );
    const offenders = files
      .filter((file) => readFileSync(file, "utf8").includes("__btn"))
      .map(toPosix)
      .filter((file) => !BESPOKE_BTN_ALLOWLIST.some((allowed) => file.endsWith(allowed)));
    expect(
      offenders,
      "Compose from the Button primitive (src/components/ui/Button.tsx) instead of a " +
        `bespoke __btn class in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  /**
   * (3c) Standalone raw-hex ratchet in component CSS. `var(--token, #hex)`
   * fallbacks are acceptable defensive defaults and are exempt: any line where
   * the hex sits inside a `var(...)` fallback is ignored. A currently-clean file
   * that adds a bare raw hex (e.g. `background: #123456;`) FAILS. Allowlist is
   * empty after #1083 migrated the last standalone usages to tokens.
   */
  it("introduces no new standalone raw hex literals in component CSS", () => {
    const offenders: string[] = [];
    for (const file of cssFiles) {
      if (toPosix(file).includes("/components/ui/")) continue;
      if (RAW_HEX_CSS_ALLOWLIST.some((allowed) => file.endsWith(allowed))) continue;
      if (hasStandaloneRawHex(readFileSync(file, "utf8"))) offenders.push(toPosix(file));
    }
    expect(
      offenders,
      "Reference a token from src/styles/variables.css instead of a raw hex literal in: " +
        `${offenders.join(", ")}`
    ).toEqual([]);
  });
});

/**
 * Collect every design token DEFINED anywhere the app can define one:
 *  - as a `--token:` custom-property declaration in any `src/**\/*.css`
 *    (variables.css, global.css, animations.css, per-component files, …), and
 *  - as a runtime custom property written by the theme engine
 *    (`COLOR_TO_CSS_VAR` in src/themes/engine.ts), which sets per-theme values
 *    on `document.documentElement` and therefore never appears as a static
 *    `:root { --x: … }` declaration.
 *
 * @returns The set of every `--token` name that resolves at runtime.
 */
function collectDefinedTokens(): Set<string> {
  const defined = new Set<string>();
  const declRe = /(--[a-z0-9-]+)\s*:/gi;
  for (const file of collectFiles(SRC_DIR, (name) => name.endsWith(".css"))) {
    const css = stripCssComments(readFileSync(file, "utf8"));
    for (const m of css.matchAll(declRe)) defined.add(m[1]);
  }
  // Runtime-defined tokens: the string literals in engine.ts's CSS-var map.
  const engine = readFileSync(join(THEMES_DIR, "engine.ts"), "utf8");
  for (const m of engine.matchAll(/"(--[a-z0-9-]+)"/gi)) defined.add(m[1]);
  return defined;
}

/**
 * Undefined-token guard (#2052). A `var(--token)` reference with **no fallback**
 * resolves to nothing when `--token` is undefined — the property is dropped,
 * rendering the element transparent / borderless. A token-rename migration left
 * a cluster of these dangling (the Ctrl+F terminal search bar went transparent
 * and borders vanished across 13+ stylesheets), so this guard fails on any
 * bare, fallback-less `var(--token)` whose token is not defined anywhere.
 *
 * Scope note: the fallback-bearing form `var(--token, <fallback>)` was originally
 * EXEMPT here — the fallback renders, so an undefined token there degrades
 * gracefully rather than silently breaking. That cleanup landed as a follow-up
 * (#2063), which reconciled every undefined-but-fallback'd reference, so the
 * fallback form is now guarded too (see the fallback-bearing test below) — an
 * undefined token can no longer hide behind a fallback and mask a stale rename.
 */
describe("undefined design-token guard (#2052)", () => {
  const definedTokens = collectDefinedTokens();

  it("defines the core tokens it depends on (sanity check)", () => {
    for (const tok of ["--bg-secondary", "--border-primary", "--bg-input", "--tab-bg"]) {
      expect(definedTokens.has(tok), `${tok} should be a defined token`).toBe(true);
    }
  });

  it("has no fallback-less var(--token) reference to an undefined token", () => {
    // `var(--token)` with no comma before the closing paren — i.e. no fallback.
    const bareVarRe = /var\(\s*(--[a-z0-9-]+)\s*\)/gi;
    const offenders: string[] = [];
    for (const file of collectCssFiles(COMPONENTS_DIR)) {
      const css = stripCssComments(readFileSync(file, "utf8"));
      const bad = new Set<string>();
      for (const m of css.matchAll(bareVarRe)) {
        if (!definedTokens.has(m[1])) bad.add(m[1]);
      }
      if (bad.size > 0) offenders.push(`${toPosix(file)} → ${[...bad].join(", ")}`);
    }
    expect(
      offenders,
      "Fallback-less var(--token) references must resolve to a token defined in " +
        "src/styles/variables.css (or written by the theme engine). Rename each to the " +
        `current token or add the token. Dangling in:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  /**
   * Fallback-bearing ratchet (#2063). A `var(--token, <fallback>)` whose token is
   * undefined still *renders* (via the fallback), so it does not visibly break —
   * but the token name is stale/dangling and the fallback silently masks the
   * rename. #2063 reconciled every such reference (define the token, or repoint to
   * the current token whose value matches), leaving this set empty. The guard is
   * the ratchet: a newly-introduced `var(--undefined, <fallback>)` now FAILS,
   * forcing the token to be defined rather than papered over with a fallback.
   *
   * FALLBACK_UNDEFINED_ALLOWLIST is a shrinking ratchet — add a repo-relative
   * suffix (POSIX separators) only with a written justification, and remove it as
   * the underlying token is reconciled.
   */
  const FALLBACK_UNDEFINED_ALLOWLIST: string[] = [];

  it("has no fallback-bearing var(--token, …) reference to an undefined token", () => {
    // `var(--token,` — a token name immediately followed by a comma (a fallback).
    // Only the outer token name is captured; the fallback (which may itself nest
    // var()/color-mix() with parens) is not parsed, so nesting is handled.
    const fallbackVarRe = /var\(\s*(--[a-z0-9-]+)\s*,/gi;
    const offenders: string[] = [];
    for (const file of collectCssFiles(COMPONENTS_DIR)) {
      if (FALLBACK_UNDEFINED_ALLOWLIST.some((allowed) => toPosix(file).endsWith(allowed))) {
        continue;
      }
      const css = stripCssComments(readFileSync(file, "utf8"));
      const bad = new Set<string>();
      for (const m of css.matchAll(fallbackVarRe)) {
        if (!definedTokens.has(m[1])) bad.add(m[1]);
      }
      if (bad.size > 0) offenders.push(`${toPosix(file)} → ${[...bad].join(", ")}`);
    }
    expect(
      offenders,
      "Fallback-bearing var(--token, <fallback>) references must also resolve to a defined " +
        "token — the fallback must not mask a dangling token name. Define the token in " +
        "src/styles/variables.css (or the theme engine) or repoint to the current token whose " +
        `value matches the fallback. Dangling in:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });
});

/**
 * Z-index scale guard (UI-002).
 *
 * Before this, only two z-index tokens existed (`--z-dropdown`, `--z-toast`) and
 * ~20 raw literals were scattered across components with no coherent ordering:
 * the update banner (9000) and the decorative noise overlay (9999) both rendered
 * ABOVE modals/toasts (1000), so a banner or overlay could cover an open dialog.
 *
 * These guards pin the layering contract so it cannot silently drift again:
 *  - the scale is defined once in variables.css and is strictly monotonic, and
 *  - component CSS references `--z-*` tokens rather than raw numeric z-index.
 */
describe("z-index scale (UI-002)", () => {
  /** Parse the numeric `--z-*` tokens declared in variables.css. */
  function zTokens(): Map<string, number> {
    const css = stripCssComments(readFileSync(join(STYLES_DIR, "variables.css"), "utf8"));
    const out = new Map<string, number>();
    for (const m of css.matchAll(/(--z-[a-z0-9-]+)\s*:\s*(\d+)\s*;/gi)) {
      out.set(m[1], Number(m[2]));
    }
    return out;
  }

  const tokens = zTokens();
  const z = (name: string): number => {
    const v = tokens.get(name);
    expect(v, `variables.css must define ${name}`).toBeTypeOf("number");
    return v as number;
  };

  it("defines the full ordered scale as strictly increasing values", () => {
    // Low → high. Component-local in-view layers, then the app-level surfaces.
    const order = [
      "--z-base",
      "--z-raised",
      "--z-elevated",
      "--z-layer",
      "--z-float",
      "--z-float-top",
      "--z-dropdown",
      "--z-sticky",
      "--z-overlay",
      "--z-banner",
      "--z-scrim",
      "--z-modal",
      "--z-popover",
      "--z-toast",
      "--z-tooltip",
      "--z-max",
    ];
    const values = order.map(z);
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `${order[i]} (${values[i]}) must sit above ${order[i - 1]} (${values[i - 1]})`
      ).toBeGreaterThan(values[i - 1]);
    }
  });

  it("keeps modals above page banners and the noise/scrim overlay (the UI-002 bug)", () => {
    // The concrete bug: a banner/overlay must never cover an open modal dialog.
    expect(z("--z-modal")).toBeGreaterThan(z("--z-banner"));
    expect(z("--z-modal")).toBeGreaterThan(z("--z-overlay"));
    // The modal's own scrim sits just below the modal surface.
    expect(z("--z-scrim")).toBeLessThan(z("--z-modal"));
  });

  it("keeps popovers, toasts and tooltips at or above the modal layer", () => {
    // Radix Select/menu content opened inside a modal form, plus toasts and
    // tooltips, must render above the modal — never behind it.
    expect(z("--z-popover")).toBeGreaterThanOrEqual(z("--z-modal"));
    expect(z("--z-toast")).toBeGreaterThan(z("--z-modal"));
    expect(z("--z-tooltip")).toBeGreaterThan(z("--z-modal"));
  });

  it("uses --z-* tokens for every z-index in app CSS (no raw literals)", () => {
    // A raw numeric z-index bypasses the scale and reintroduces the drift this
    // finding fixed. Every z-index — component CSS, the shared styles (except
    // the scale itself in variables.css) and top-level app CSS — must reference
    // a token (#4347 widened this from components-only).
    const rawZIndexRe = /z-index\s*:\s*-?\d/i;
    const offenders: string[] = [];
    const appCss = [
      ...cssFiles,
      ...collectFiles(STYLES_DIR, (name) => name.endsWith(".css") && name !== "variables.css"),
      ...readdirSync(SRC_DIR)
        .filter((name) => name.endsWith(".css"))
        .map((name) => join(SRC_DIR, name)),
    ];
    for (const file of appCss) {
      const css = stripCssComments(readFileSync(file, "utf8"));
      if (css.split("\n").some((line) => rawZIndexRe.test(line))) {
        offenders.push(toPosix(file));
      }
    }
    expect(
      offenders,
      "Reference a --z-* token from src/styles/variables.css instead of a raw z-index in: " +
        `${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("sets no numeric inline zIndex in component TSX", () => {
    // Inline styles bypass the CSS guard above; a `zIndex: 50` in a style prop
    // is the same magic number in a different place.
    const tsxFiles = collectFiles(
      COMPONENTS_DIR,
      (name) => name.endsWith(".tsx") && !name.includes(".test.")
    );
    const offenders = tsxFiles
      .filter((file) => /zIndex\s*:\s*-?\d/.test(readFileSync(file, "utf8")))
      .map(toPosix);
    expect(
      offenders,
      `Use a --z-* token instead of a numeric inline zIndex in: ${offenders}`
    ).toEqual([]);
  });

  /**
   * UI2-001 / #4347: every portaled Radix content (Select, DropdownMenu,
   * ContextMenu, Popover, Tooltip, incl. SubContent) must stack at or above
   * `--z-popover`. Radix copies the content's z-index onto its popper wrapper
   * in document.body, so a menu styled with `--z-sticky` (100) opened under the
   * modal scrim (900), the modal (1000) and the update banner (500).
   */
  describe("portaled Radix content stacks above modals and banners (#4347)", () => {
    const radixContentRe =
      /<(?:DropdownMenu|ContextMenu|RadixSelect|Select|Popover|RadixPopover|RadixTooltip)\.(?:Sub)?Content\b[^>]*?className="([^"]+)"/g;

    /** First class of every Radix popper Content's className across components. */
    function radixContentClasses(): Map<string, string> {
      const out = new Map<string, string>();
      const tsxFiles = collectFiles(
        COMPONENTS_DIR,
        (name) => name.endsWith(".tsx") && !name.includes(".test.")
      );
      for (const file of tsxFiles) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(radixContentRe)) {
          const first = m[1].trim().split(/\s+/)[0];
          if (!out.has(first)) out.set(first, toPosix(file));
        }
      }
      return out;
    }

    /** The `--z-*` token each `.cls { ... z-index: var(--z-x) }` rule uses. */
    function zTokensForClass(cls: string): string[] {
      const found: string[] = [];
      const ruleRe = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`, "g");
      for (const file of cssFiles) {
        const css = stripCssComments(readFileSync(file, "utf8"));
        for (const rule of css.matchAll(ruleRe)) {
          const zm = /z-index\s*:\s*var\((--z-[a-z0-9-]+)\)/.exec(rule[1]);
          if (zm) found.push(zm[1]);
        }
      }
      return found;
    }

    const classes = radixContentClasses();

    it("finds the known portaled menu content classes", () => {
      // Sanity check that the scan is not silently matching nothing.
      for (const cls of [
        "context-menu__content",
        "settings-menu__content",
        "indent-menu__content",
        "lang-menu__content",
        "monitoring-menu__content",
        "ui-select__content",
        "ui-tooltip__content",
      ]) {
        expect(classes.has(cls), `expected a Radix Content using .${cls}`).toBe(true);
      }
    });

    it("styles every Radix Content class with a z-index tier above the modal", () => {
      const offenders: string[] = [];
      for (const [cls, file] of classes) {
        const used = zTokensForClass(cls);
        if (used.length === 0) {
          offenders.push(`.${cls} (${file}): no z-index token`);
          continue;
        }
        for (const token of used) {
          if (z(token) < z("--z-popover")) offenders.push(`.${cls} (${file}): ${token}`);
        }
      }
      expect(
        offenders,
        "Portaled Radix content must use --z-popover or higher, or it opens behind modals"
      ).toEqual([]);
    });

    it("keeps menus above the modal scrim, the modal and the update banner", () => {
      const menu = z("--z-popover");
      expect(menu).toBeGreaterThan(z("--z-scrim"));
      expect(menu).toBeGreaterThan(z("--z-modal"));
      expect(menu).toBeGreaterThan(z("--z-banner"));
      expect(z("--z-banner")).toBeGreaterThan(z("--z-sticky"));
    });
  });
});

/**
 * Type-scale guard (UI-005).
 *
 * Before this, the font-size scale was only four steps (xs 11 / sm 12 / md 13 /
 * lg 14) and ~150 raw `font-size: Npx` declarations sprawled across components —
 * caption/badge text at 8–10px and headings at 15–22px had no token at all, so
 * those tiers drifted per component. The scale was extended with a caption tier
 * (2xs 10px) and display tiers (xl 16 / 2xl 20 / 3xl 22), and every raw px
 * font-size migrated onto a token.
 *
 * These guards pin the scale so it cannot drift again:
 *  - the full tier scale is defined in variables.css, and
 *  - component CSS references `--font-size-*` tokens rather than raw px.
 */
describe("type scale (UI-005)", () => {
  it("defines the full font-size tier scale in variables.css", () => {
    const css = stripCssComments(readFileSync(join(STYLES_DIR, "variables.css"), "utf8"));
    for (const tok of [
      "--font-size-2xs",
      "--font-size-xs",
      "--font-size-sm",
      "--font-size-md",
      "--font-size-lg",
      "--font-size-xl",
      "--font-size-2xl",
      "--font-size-3xl",
    ]) {
      expect(css.includes(`${tok}:`), `variables.css must define ${tok}`).toBe(true);
    }
  });

  it("uses --font-size-* tokens for every font-size in component CSS (no raw px)", () => {
    // A raw px value bypasses the scale and reintroduces the drift this finding
    // fixed. A px inside a var() fallback — `var(--font-size-xs, 11px)` — is an
    // acceptable defensive default and is exempt, mirroring the raw-hex guard.
    const rawFontPxRe = /font-size:\s*\d/i;
    const varFallbackRe = /var\([^)]*\d+px/i;
    const offenders: string[] = [];
    for (const file of cssFiles) {
      const css = stripCssComments(readFileSync(file, "utf8"));
      if (css.split("\n").some((line) => rawFontPxRe.test(line) && !varFallbackRe.test(line))) {
        offenders.push(toPosix(file));
      }
    }
    expect(
      offenders,
      "Reference a --font-size-* token from src/styles/variables.css instead of a raw px " +
        `font-size in: ${offenders.join(", ")}`
    ).toEqual([]);
  });
});

/**
 * Spacing-scale guard (UI-009, #2898, #3170).
 *
 * The `--spacing-*` scale in variables.css
 * (xxs 2 · xs 4 · xs-sm 6 · sm 8 · sm-md 10 · md 12 · lg 16 · xl 24 · 2xl 32) is
 * the single source of spacing truth. #2897 tokenized every exact-match
 * `padding`/`margin`/`gap` px; #3170 reconciled the rest (maintainer option B):
 * 6px/10px gained the half-step tiers `--spacing-xs-sm` / `--spacing-sm-md`, the
 * other residuals snapped to the nearest tier (ties round down), and true
 * geometry — icon clearance, indent alignment, calc() nudges — moved into named
 * component custom properties (e.g. `--password-toggle-space`), whose
 * declarations this guard does not scan.
 *
 * SPACING_PX_ALLOWLIST is the ratchet and is now EMPTY: any component CSS file
 * that introduces an off-scale raw spacing px FAILS. Do not re-grow it — use a
 * token, or a named custom property with a comment explaining the geometry.
 *
 * Paths are repo-relative suffixes (POSIX separators), matched with `endsWith`.
 */
const SPACING_PX_ALLOWLIST: string[] = [];

describe("spacing scale (UI-009)", () => {
  it("defines the full spacing tier scale in variables.css", () => {
    const css = stripCssComments(readFileSync(join(STYLES_DIR, "variables.css"), "utf8"));
    for (const tok of [
      "--spacing-xxs",
      "--spacing-xs",
      "--spacing-xs-sm",
      "--spacing-sm",
      "--spacing-sm-md",
      "--spacing-md",
      "--spacing-lg",
      "--spacing-xl",
      "--spacing-2xl",
    ]) {
      expect(css.includes(`${tok}:`), `variables.css must define ${tok}`).toBe(true);
    }
  });

  it("introduces no new off-scale raw px in padding/margin/gap outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of cssFiles) {
      if (SPACING_PX_ALLOWLIST.some((allowed) => toPosix(file).endsWith(allowed))) continue;
      if (hasOffScaleSpacingPx(readFileSync(file, "utf8"))) offenders.push(toPosix(file));
    }
    expect(
      offenders,
      "Reference a --spacing-* token from src/styles/variables.css instead of a raw px " +
        `padding/margin/gap value in: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("keeps the spacing allowlist empty (the #3170 reconciliation is complete)", () => {
    expect(SPACING_PX_ALLOWLIST).toEqual([]);
  });
});

describe("off-scale spacing detection (UI-009)", () => {
  it("flags an off-scale raw px in padding/margin/gap", () => {
    expect(hasOffScaleSpacingPx(".a {\n  padding: 6px;\n}")).toBe(true);
    expect(hasOffScaleSpacingPx(".a {\n  gap: 10px;\n}")).toBe(true);
    expect(hasOffScaleSpacingPx(".a {\n  margin-left: 3px;\n}")).toBe(true);
  });

  it("flags an off-scale member inside a shorthand alongside a token", () => {
    expect(hasOffScaleSpacingPx(".a {\n  padding: 6px var(--spacing-sm);\n}")).toBe(true);
  });

  it("accepts values already on the token scale", () => {
    expect(
      hasOffScaleSpacingPx(".a {\n  padding: var(--spacing-sm) var(--spacing-md);\n  gap: 0;\n}")
    ).toBe(false);
  });

  it("exempts a px inside a var() fallback (defensive default)", () => {
    expect(hasOffScaleSpacingPx(".a {\n  padding: var(--spacing-md, 12px);\n}")).toBe(false);
  });

  it("exempts 1px hairlines/nudges", () => {
    expect(hasOffScaleSpacingPx(".a {\n  padding: 1px var(--spacing-xs);\n}")).toBe(false);
    expect(hasOffScaleSpacingPx(".a {\n  margin-bottom: -1px;\n}")).toBe(false);
  });

  it("does not scan named geometry custom properties (the #3170 exception)", () => {
    expect(
      hasOffScaleSpacingPx(
        ".a {\n  --password-toggle-space: 30px;\n  padding-right: var(--password-toggle-space);\n}"
      )
    ).toBe(false);
    expect(hasOffScaleSpacingPx(".a {\n  --icon-gap: 18px;\n}")).toBe(false);
  });

  it("does not scan positional offsets (top/left/inset are not spacing steps)", () => {
    expect(hasOffScaleSpacingPx(".a {\n  top: 6px;\n  inset: 6px 5px;\n}")).toBe(false);
  });
});

/**
 * The raw-hex guard must read CSS, not prose. A hash-prefixed issue reference in
 * a comment (`#1366`) is indistinguishable from a hex literal to a bare regex,
 * so the guard used to flag comments containing no colour at all (#1563).
 */
describe("raw-hex guard ignores comments (#1563)", () => {
  it("allows a hash-prefixed issue reference in a comment", () => {
    const css = `/* Session Picker (SI-3, #1366). Layout only — the dialog shell comes
   from src/components/ui/. */
.spawn-picker__path {
  color: var(--text-secondary);
}`;
    expect(hasStandaloneRawHex(css)).toBe(false);
  });

  it("allows issue references across the whole hex alphabet and digit range", () => {
    // #1e0a is a valid 4-digit issue number AND a valid 4-digit hex colour.
    for (const ref of ["#123", "#1366", "#1447", "#1e0a", "#12345678"]) {
      expect(hasStandaloneRawHex(`/* see ${ref} */\n.a {\n  color: var(--text);\n}`), ref).toBe(
        false
      );
    }
  });

  it("still flags a standalone raw hex in a declaration", () => {
    expect(hasStandaloneRawHex(".a {\n  background: #123456;\n}")).toBe(true);
  });

  it("still flags a raw hex on a line that also carries a comment", () => {
    expect(hasStandaloneRawHex(".a {\n  background: #123456; /* brand red, #1366 */\n}")).toBe(
      true
    );
  });

  it("still flags a raw hex inside a multi-line comment's host file", () => {
    const css = `/* A long header comment
   spanning lines, citing #1366. */
.a {
  color: #abcdef;
}`;
    expect(hasStandaloneRawHex(css)).toBe(true);
  });

  it("keeps var() fallbacks exempt", () => {
    expect(hasStandaloneRawHex(".a {\n  color: var(--color-error, #f44336);\n}")).toBe(false);
  });

  it("does not let a commented-out declaration mask a real one on the next line", () => {
    const css = `/* background: #ff0000; */
.a {
  background: #00ff00;
}`;
    expect(hasStandaloneRawHex(css)).toBe(true);
  });
});
