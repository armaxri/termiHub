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
const STYLES_DIR = join(SRC_DIR, "styles");
const THEMES_DIR = join(SRC_DIR, "themes");

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
 * Scope note: `var(--token, <fallback>)` is deliberately EXEMPT — the fallback
 * renders, so an undefined token there degrades gracefully rather than silently
 * breaking, exactly as the raw-hex guard exempts `var(--token, #hex)`. The
 * separately-tracked cleanup of undefined-but-fallback'd tokens is a follow-up.
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
