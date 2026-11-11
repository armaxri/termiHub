import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";

/**
 * Secondary / muted text on accent-tinted selected rows (#5398).
 *
 * `--bg-selected` (18% accent) drops plain `--text-secondary` and
 * `--text-muted` below WCAG AA (Dark ~4.1:1, Light ~3.7:1, Solarized Dark
 * ~4.1:1). Every rule that paints it redirects both tokens to their
 * `*-on-selection` counterparts for the whole subtree, so every secondary
 * label or muted hint inside the row switches with it. The tokens themselves
 * are graded on the blended surface by `src/themes/contrast.test.ts`; this
 * pins the redirects and fails if a new `--bg-selected` rule forgets them.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [CSS file under src/, selector that paints --bg-selected and must redirect]. */
const SELECTED_REDIRECTS: [string, string][] = [
  ["components/Sidebar/ConnectionList.css", ".connection-tree__item--selected"],
  ["components/Sidebar/FileBrowser.css", ".file-browser__row-wrapper--drop-valid"],
  ["components/Sidebar/FileBrowser.css", ".file-browser__row-wrapper--drop-valid:hover"],
  ["components/TransferView/TransferView.css", ".transfer-pane--drop-target"],
  ["components/TransferView/TransferView.css", ".transfer-pane__row--selected"],
];

/**
 * `--bg-selected` rules that carry no secondary or muted text, with the reason.
 * A selector here is exempt from the redirect but still may not colour itself
 * with plain `--text-secondary` / `--text-muted`.
 */
const EXEMPT: Record<string, string> = {
  // Breadcrumb drop target: a single label already recoloured to --text-primary.
  ".file-browser__crumb--drop-valid": "text is --text-primary",
  // Info banner: plain text in --text-accent, no secondary/muted children.
  ".network-panel__info": "text is --text-accent",
  // xterm decoration overlay: no DOM text of its own.
  ".terminal-container .xterm-decoration.terminal-prompt-flash": "no text",
};

const SECONDARY_REDIRECT = /--text-secondary:\s*var\(--text-secondary-on-selection\)/;
const MUTED_REDIRECT = /--text-muted:\s*var\(--text-muted-on-selection\)/;
const PAINTS_SELECTED = /background(-color)?:\s*var\(--bg-selected\)/;
const PLAIN_TEXT_COLOR = /(^|[\s;])color:\s*var\(--text-(secondary|muted)\)/;

/** Map each selector in `css` to the declarations of the rule it heads. */
function rules(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(",")) out.set(sel.trim(), m[2]);
  }
  return out;
}

/** Every `.css` file under src/, relative to src/. */
function cssFiles(): string[] {
  return (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".css"))
    .map((f) => relative(SRC_DIR, join(SRC_DIR, f)));
}

describe("--bg-selected rows redirect secondary/muted text to the on-selection tokens (#5398)", () => {
  for (const [file, selector] of SELECTED_REDIRECTS) {
    it(`${file}: ${selector}`, () => {
      const body = rules(readFileSync(join(SRC_DIR, file), "utf8")).get(selector);
      expect(body, `missing rule for ${selector}`).toBeDefined();
      expect(body).toMatch(PAINTS_SELECTED);
      expect(body).toMatch(SECONDARY_REDIRECT);
      expect(body).toMatch(MUTED_REDIRECT);
    });
  }

  it("every --bg-selected rule in src/ redirects both tokens or is exempt", () => {
    const pinned = new Set(SELECTED_REDIRECTS.map(([, sel]) => sel));
    const offenders: string[] = [];
    const seen: string[] = [];
    for (const file of cssFiles()) {
      for (const [selector, body] of rules(readFileSync(join(SRC_DIR, file), "utf8"))) {
        if (!PAINTS_SELECTED.test(body)) continue;
        seen.push(selector);
        if (PLAIN_TEXT_COLOR.test(body)) {
          offenders.push(`${file}: ${selector} colours text with plain secondary/muted`);
        }
        if (selector in EXEMPT) continue;
        if (!SECONDARY_REDIRECT.test(body) || !MUTED_REDIRECT.test(body)) {
          offenders.push(`${file}: ${selector} does not redirect to the on-selection tokens`);
        } else if (!pinned.has(selector)) {
          offenders.push(`${file}: ${selector} redirects but is not pinned in SELECTED_REDIRECTS`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Guard against the scan silently matching nothing.
    expect(seen).toEqual(expect.arrayContaining([...pinned, ...Object.keys(EXEMPT)]));
  });
});
