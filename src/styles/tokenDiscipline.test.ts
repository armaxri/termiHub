import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, dirname } from "path";
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

/**
 * Recursively collect every `*.css` file under the components tree.
 *
 * @param dir Absolute directory to walk.
 * @returns Absolute paths of all `.css` files found.
 */
function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectCssFiles(full));
    } else if (entry.endsWith(".css")) {
      out.push(full);
    }
  }
  return out;
}

const cssFiles = collectCssFiles(COMPONENTS_DIR);

/**
 * Documented allowlist of files permitted to contain a bare `#fff`/`#ffffff`.
 *
 * Empty by design: every hardcoded white in the component CSS was replaced by
 * a token during #1059. Add an entry here only with a written justification in
 * the final report if a genuinely token-less pure-white case is reintroduced.
 */
const WHITE_ALLOWLIST: string[] = [];

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
