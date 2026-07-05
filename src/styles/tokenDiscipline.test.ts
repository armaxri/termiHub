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

const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

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
 * ConnectionEditor / TunnelEditor / WorkspaceEditor (migrated in #1085/#1094)
 * and the Settings / NetworkTools panels / FileBrowser / TerminalSearchBar /
 * UpdateNotification buttons (migrated in #1096) were all moved onto the `Button`
 * primitive and removed from this list. The only remaining entry is
 * NetworkTools/NetworkTools.css, which still carries `network-sidebar__btn` for
 * the NetworkToolsSidebar (out of #1096's panel scope — tracked as a follow-up).
 * Do NOT assert this list has no stale entries — that would cause cross-PR
 * breakage.
 *
 * Paths are repo-relative suffixes (POSIX separators), matched with `endsWith`.
 */
const BESPOKE_BTN_ALLOWLIST: string[] = ["NetworkTools/NetworkTools.css"];

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

describe("CSS token discipline (#1059)", () => {
  it("finds component CSS files to scan", () => {
    expect(cssFiles.length).toBeGreaterThan(0);
  });

  it("has no ad-hoc rgba(0, 0, 0, 0.7) overlay scrims", () => {
    const offenders: string[] = [];
    // Matches rgba(0,0,0,0.7) with any internal whitespace.
    const overlayRe = /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0?\.7\s*\)/i;
    for (const file of cssFiles) {
      if (overlayRe.test(readFileSync(file, "utf8"))) {
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
      if (whiteRe.test(readFileSync(file, "utf8"))) {
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
    // A line is exempt when its hex appears inside a var() fallback, e.g.
    // `color: var(--color-error, #f44336);`.
    const varFallbackRe = /var\([^)]*#[0-9a-f]/i;
    const rawHexRe = /#[0-9a-f]{3,8}\b/i;
    const offenders: string[] = [];
    for (const file of cssFiles) {
      if (toPosix(file).includes("/components/ui/")) continue;
      if (RAW_HEX_CSS_ALLOWLIST.some((allowed) => file.endsWith(allowed))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      const hasRawHex = lines.some((line) => !varFallbackRe.test(line) && rawHexRe.test(line));
      if (hasRawHex) offenders.push(toPosix(file));
    }
    expect(
      offenders,
      "Reference a token from src/styles/variables.css instead of a raw hex literal in: " +
        `${offenders.join(", ")}`
    ).toEqual([]);
  });
});
