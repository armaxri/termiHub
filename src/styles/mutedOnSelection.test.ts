import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Muted row hints on hovered / selected rows (#5200).
 *
 * `--text-muted` falls below WCAG AA on the row-state backgrounds
 * (`--bg-hover` / `--bg-active`), so every muted hint inside a row that paints
 * one of them switches to `--text-muted-on-selection` in that state. The token
 * itself is graded by `src/themes/contrast.test.ts`; this pins each row's
 * override so a CSS refactor cannot silently drop it.
 */

const COMPONENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "components");

/** [CSS file, row-state selector that must recolour the hint]. */
const ROW_HINT_OVERRIDES: [string, string][] = [
  ["Spawn/SpawnPicker.css", ".spawn-picker__row:hover .spawn-picker__row-hint"],
  ["Spawn/SpawnPicker.css", ".spawn-picker__row--selected .spawn-picker__row-hint"],
  ["Plugins/Plugins.css", ".plugin-row:hover .plugin-row__ver"],
  ["Plugins/Plugins.css", ".plugin-row--selected .plugin-row__ver"],
  ["OpenConnections/OpenConnectionsModal.css", ".oc-row:hover .oc-row__title--muted"],
  ["OpenConnections/OpenConnectionsModal.css", ".oc-row:hover .oc-row__detail"],
  ["OpenConnections/OpenConnectionsModal.css", ".oc-row:hover .oc-row__window:not(:hover)"],
  ["OpenConnections/OpenConnectionsModal.css", ".oc-row:hover .oc-transfer__meta"],
  ["TransferQueue/TransferQueue.css", ".transfer-row:hover .transfer-row__status--cancelled"],
  ["LogViewer/LogViewer.css", ".log-viewer__entry:hover .log-viewer__timestamp"],
  ["LogViewer/LogViewer.css", ".log-viewer__entry:hover .log-viewer__target"],
  ["StatusBar/StatusBar.css", ".ui-menu__item:hover .monitoring-menu__radio-default"],
  ["StatusBar/StatusBar.css", ".ui-menu__item[data-highlighted] .monitoring-menu__radio-default"],
  ["NetworkTools/NetworkTools.css", ".sidebar-list-item:hover .network-sidebar__monitor-meta"],
];

/** Map each selector in `css` to the declarations of the rule it heads. */
function rules(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of m[1].split(",")) out.set(sel.trim(), m[2]);
  }
  return out;
}

describe("muted row hints use --text-muted-on-selection on hover/selection (#5200)", () => {
  for (const [file, selector] of ROW_HINT_OVERRIDES) {
    it(`${file}: ${selector}`, () => {
      const body = rules(readFileSync(join(COMPONENTS_DIR, file), "utf8")).get(selector);
      expect(body, `missing rule for ${selector}`).toBeDefined();
      expect(body).toMatch(/color:\s*var\(--text-muted-on-selection\)/);
    });
  }
});
