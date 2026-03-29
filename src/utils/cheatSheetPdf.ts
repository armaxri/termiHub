import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  getDefaultBindings,
  getEffectiveCombo,
  serializeBinding,
  getOverrides,
} from "@/services/keybindings";
import { ShortcutCategory } from "@/types/keybindings";

const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  general: "General",
  clipboard: "Clipboard",
  terminal: "Terminal",
  navigation: "Navigation / Split",
  "tab-groups": "Tab Groups",
};

const CATEGORY_ORDER: ShortcutCategory[] = [
  "general",
  "clipboard",
  "terminal",
  "navigation",
  "tab-groups",
];

const CHEAT_SHEET_FILENAME = "termihub-shortcuts.html";

/**
 * Build a self-contained HTML document for the keyboard shortcut cheat sheet.
 */
export function buildCheatSheetHtml(): string {
  const bindings = getDefaultBindings();
  const overriddenActions = new Set(getOverrides().map((o) => o.action));

  const groups = CATEGORY_ORDER.map((cat) => ({
    label: CATEGORY_LABELS[cat],
    bindings: bindings.filter((b) => b.category === cat),
  })).filter((g) => g.bindings.length > 0);

  const gridHtml = groups
    .map((group) => {
      const rows = group.bindings
        .map((b) => {
          const combo = getEffectiveCombo(b.action) ?? b.winLinuxDefault;
          const keyStr = serializeBinding(combo);
          const isOverride = overriddenActions.has(b.action);
          const overrideMark = isOverride
            ? '<span class="override-mark" title="Custom binding">&dagger;</span>'
            : "";
          return `<tr>
              <td class="action">${b.label}${overrideMark}</td>
              <td class="key"><kbd>${keyStr}</kbd></td>
            </tr>`;
        })
        .join("");

      return `<div class="group">
          <h3>${group.label}</h3>
          <table><tbody>${rows}</tbody></table>
        </div>`;
    })
    .join("");

  const hasOverrides = overriddenActions.size > 0;
  const footerNote = hasOverrides
    ? '<p class="footer-note"><span class="override-mark">&dagger;</span> Custom binding (user override)</p>'
    : "<p></p>";

  const date = new Date().toLocaleDateString(undefined, {
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
      grid-template-columns: repeat(3, 1fr);
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
 */
export async function exportCheatSheet(): Promise<void> {
  const filePath = await save({
    title: "Save Keyboard Shortcuts Cheat Sheet",
    defaultPath: CHEAT_SHEET_FILENAME,
    filters: [{ name: "HTML File", extensions: ["html"] }],
  });
  if (!filePath) return;

  await writeTextFile(filePath, buildCheatSheetHtml());
}
