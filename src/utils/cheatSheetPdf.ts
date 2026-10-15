import { save } from "@/services/nativeDialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  getDefaultBindings,
  getEffectiveCombo,
  formatBindingForDisplay,
  getOverrides,
  isUnboundCombo,
} from "@/services/keybindings";
import { KeyBinding, KeyCombo, ShortcutCategory } from "@/types/keybindings";
import { resolveUiLocale } from "@/utils/locale";
import { isMac } from "@/utils/platform";

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / Split",
  "tab-groups": "Tab Groups",
  "remote-desktop": "Remote Desktop",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "clipboard",
  "terminal",
  "navigation",
  "tab-groups",
  "remote-desktop",
];

const CHEAT_SHEET_FILENAME = "termihub-shortcuts.html";

/**
 * Which platforms the cheat sheet lists (#4711): `"current"` prints one key
 * column for the running platform; `"all"` prints a Win / Linux and a macOS
 * column, handy when sharing the sheet with users on another OS.
 */
export type CheatSheetPlatforms = "current" | "all";

/** Display text for a combo, or "Unbound" for none / an explicit unbind. */
function bindingText(combo: KeyCombo | KeyCombo[] | null, mac: boolean): string {
  return combo && !isUnboundCombo(combo) ? formatBindingForDisplay(combo, mac) : "Unbound";
}

/**
 * A binding's key text for one platform. The running platform shows the
 * effective binding (user override or default); the other platform shows its
 * built-in default, since overrides are stored for this machine only.
 */
function platformBindingText(binding: KeyBinding, mac: boolean): string {
  if (mac === isMac()) return bindingText(getEffectiveCombo(binding.action), mac);
  return bindingText(mac ? binding.macDefault : binding.winLinuxDefault, mac);
}

/**
 * Build a self-contained HTML document for the keyboard shortcut cheat sheet.
 *
 * @param platforms - `"current"` (default) for the running platform only, or
 *   `"all"` for a Win / Linux and a macOS column.
 */
export function buildCheatSheetHtml(platforms: CheatSheetPlatforms = "current"): string {
  const bindings = getDefaultBindings();
  const overriddenActions = new Set(getOverrides().map((o) => o.action));
  const allPlatforms = platforms === "all";

  const groups = CATEGORY_ORDER.map((cat) => ({
    label: CATEGORY_LABELS[cat],
    bindings: bindings.filter((b) => b.category === cat),
  })).filter((g) => g.bindings.length > 0);

  const tableHead = allPlatforms
    ? '<thead><tr><th class="action">Action</th><th class="key">Win / Linux</th><th class="key">macOS</th></tr></thead>'
    : "";

  const gridHtml = groups
    .map((group) => {
      const rows = group.bindings
        .map((b) => {
          const isOverride = overriddenActions.has(b.action);
          const overrideMark = isOverride
            ? '<span class="override-mark" title="Custom binding">&dagger;</span>'
            : "";
          const keyCells = allPlatforms
            ? `<td class="key"><kbd>${platformBindingText(b, false)}</kbd></td>
              <td class="key"><kbd>${platformBindingText(b, true)}</kbd></td>`
            : `<td class="key"><kbd>${platformBindingText(b, isMac())}</kbd></td>`;
          return `<tr>
              <td class="action">${b.label}${overrideMark}</td>
              ${keyCells}
            </tr>`;
        })
        .join("");

      return `<div class="group">
          <h3>${group.label}</h3>
          <table>${tableHead}<tbody>${rows}</tbody></table>
        </div>`;
    })
    .join("");

  const hasOverrides = overriddenActions.size > 0;
  const footerNote = hasOverrides
    ? '<p class="footer-note"><span class="override-mark">&dagger;</span> Custom binding (user override)</p>'
    : "<p></p>";

  const date = new Date().toLocaleDateString(resolveUiLocale(), {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>termiHub &mdash; Keyboard Shortcuts</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    @page { size: A4 landscape; margin: 12mm 14mm; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 9pt;
      color: #1a1a1a;
      background: #fff;
    }

    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 2px solid #333;
      padding-bottom: 4px;
      margin-bottom: 10px;
    }

    header h1 { font-size: 14pt; font-weight: 700; letter-spacing: -0.3px; }
    header p  { font-size: 8pt; color: #666; }

    .grid {
      display: grid;
      grid-template-columns: repeat(${allPlatforms ? 2 : 3}, 1fr);
      gap: 10px 16px;
    }

    .group h3 {
      font-size: 8pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #555;
      border-bottom: 1px solid #ccc;
      padding-bottom: 2px;
      margin-bottom: 4px;
    }

    table { width: 100%; border-collapse: collapse; }

    td { padding: 1.5px 2px; vertical-align: middle; }

    th { font-size: 7pt; font-weight: 600; color: #777; padding: 0 2px 2px; text-align: left; }
    th.key { text-align: right; }

    td.action { color: #1a1a1a; padding-right: 6px; white-space: nowrap; }
    td.key    { text-align: right; white-space: nowrap; }

    kbd {
      display: inline-block;
      font-family: "SF Mono", "Fira Mono", "Consolas", monospace;
      font-size: 8pt;
      background: #f0f0f0;
      border: 1px solid #bbb;
      border-radius: 3px;
      padding: 0 4px;
      line-height: 1.5;
      color: #222;
    }

    .override-mark { color: #0066cc; font-size: 7pt; margin-left: 2px; vertical-align: super; }

    footer {
      margin-top: 8px;
      border-top: 1px solid #ccc;
      padding-top: 4px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    footer p     { font-size: 7.5pt; color: #888; }
    .footer-note { color: #0066cc !important; }

    @media print {
      body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
  </style>
</head>
<body>
  <header>
    <h1>termiHub &mdash; Keyboard Shortcuts</h1>
    <p>Generated ${date}</p>
  </header>

  <div class="grid">${gridHtml}</div>

  <footer>
    ${footerNote}
    <p>termiHub &mdash; keyboard cheat sheet</p>
  </footer>
</body>
</html>`;
}

/**
 * Save the keyboard shortcut cheat sheet as an HTML file.
 * Opens a native save dialog so the user can choose the location.
 *
 * @param platforms - which platforms to list (see {@link CheatSheetPlatforms}).
 */
export async function exportCheatSheet(platforms: CheatSheetPlatforms = "current"): Promise<void> {
  const filePath = await save({
    title: "Save Keyboard Shortcuts Cheat Sheet",
    defaultPath: CHEAT_SHEET_FILENAME,
    filters: [{ name: "HTML File", extensions: ["html"] }],
  });
  if (!filePath) return;

  await writeTextFile(filePath, buildCheatSheetHtml(platforms));
}
