import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Secondary text on hovered / selected rows (#5249).
 *
 * `--text-secondary` falls below WCAG AA on the row-state backgrounds
 * (`--bg-hover` / `--bg-active`): Dark 4.44:1 / 4.06:1, Light 4.00:1 selected.
 * Each row state below redirects `--text-secondary` to
 * `--text-secondary-on-selection` for its whole subtree, so every secondary
 * label inside the row (meta, counts, paths, shortcuts) switches with it. The
 * token itself is graded by `src/themes/contrast.test.ts`; this pins each
 * redirect so a CSS refactor cannot silently drop it.
 */

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [CSS file under src/, row-state selector that must redirect the token]. */
const ROW_STATE_REDIRECTS: [string, string][] = [
  ["components/ConnectionEditor/SshConfigImportDialog.css", ".ssh-config-import__row:hover"],
  ["components/Sidebar/BulkSshImportDialog.css", ".bulk-ssh-import__row:hover"],
  ["components/Sidebar/FleetOnboardDialog.css", ".fleet-onboard__row:hover"],
  ["components/Sidebar/AgentSetupDialog.css", ".agent-setup-dialog__source-option:hover"],
  ["components/LogViewer/LogViewer.css", ".log-viewer__entry:hover"],
  [
    "components/LogViewer/LogViewer.css",
    ".log-viewer__level-filter--active.log-viewer__level-filter--debug",
  ],
  ["components/MacroSidebar/MacroEditorDialog.css", ".macro-editor__step:hover"],
  ["components/OpenConnections/OpenConnectionsModal.css", ".oc-row:hover"],
  ["components/Plugins/Plugins.css", ".plugin-row:hover"],
  ["components/Plugins/Plugins.css", ".plugin-row--selected"],
  [
    "components/RecentSessionsSidebar/RecentSessionsSidebar.css",
    ".recent-sessions__autocomplete-item:hover",
  ],
  ["components/Settings/KeyPathInput.css", ".key-path-input__option:hover"],
  ["components/Sidebar/ConnectionList.css", ".connection-tree__folder:hover"],
  ["components/Sidebar/ConnectionList.css", ".connection-tree__folder--drop-over"],
  ["components/Sidebar/FileBrowser.css", ".file-browser__row-wrapper:hover"],
  ["components/Sidebar/FileBrowser.css", ".file-browser__row-wrapper--selected"],
  ["components/Sidebar/FileBrowser.css", ".file-bookmarks__row:hover"],
  ["components/SidebarListItem/SidebarListItem.css", ".sidebar-list-item:hover"],
  ["components/StatusBar/StatusBar.css", ".process-table__row:hover"],
  ["components/StatusBar/StatusBar.css", ".status-bar__item--interactive:hover"],
  ["components/CommandPalette/CommandPalette.css", ".command-palette__item--active"],
  ["components/TransferQueue/TransferQueue.css", ".transfer-row:hover"],
  ["components/TransferView/TransferView.css", ".transfer-pane__row:hover"],
  ["components/WorkflowSidebar/WorkflowEditorDialog.css", ".workflow-step"],
  ["components/WorkflowSidebar/WorkflowSidebar.css", ".workflow-item__tag"],
  ["components/MacroSidebar/MacroSidebar.css", ".macro-item__tag"],
  ["components/ui/ui.css", ".ui-select__item[data-highlighted]"],
  ["components/ui/ui.css", ".ui-menu__item:hover"],
  ["components/ui/ui.css", '.ui-menu__sub-trigger[data-state="open"]'],
  ["components/ui/ui.css", ".ui-radio-card:hover:not(:disabled)"],
  ["styles/settings-form.css", ".settings-form__container-option:hover"],
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

describe("row states redirect --text-secondary to --text-secondary-on-selection (#5249)", () => {
  for (const [file, selector] of ROW_STATE_REDIRECTS) {
    it(`${file}: ${selector}`, () => {
      const body = rules(readFileSync(join(SRC_DIR, file), "utf8")).get(selector);
      expect(body, `missing rule for ${selector}`).toBeDefined();
      expect(body).toMatch(/--text-secondary:\s*var\(--text-secondary-on-selection\)/);
      // The row-state rule must also paint a row background, or the redirect
      // is guarding nothing.
      expect(body).toMatch(/background(-color)?:\s*var\(--bg-(hover|active)\)/);
    });
  }
});
