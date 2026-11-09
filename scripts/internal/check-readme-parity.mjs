#!/usr/bin/env node
// Keep README.md's descriptions of the UI in step with the app (MKT2-002/-004/-005, #4924).
//
// Three README passages restate facts that live in code, and each has drifted
// before. This check reads the code lightly (regexes, no build) and fails with
// a message naming the mismatch when:
//
//   1. the "Activity Bar" bullet's view lists differ from the ActivityBar items
//      in src/components/ActivityBar/ActivityBar.tsx — the views always shown
//      and the ones behind the `experimental` flag;
//   2. the "Authentication Methods" bullets differ from the SSH `authMethod`
//      select options in core/src/backends/ssh/mod.rs, or mark another default;
//   3. a row of the "Keyboard Shortcuts" table differs from the defaults in
//      src/services/keybindings.ts (macOS and Windows/Linux columns).
//
// check-readme-parity.test.mjs also cross-checks the keybinding parser against
// the real DEFAULT_BINDINGS export, so a source-layout change that the regexes
// misread fails loudly instead of passing silently.
//
// Usage: node scripts/internal/check-readme-parity.mjs [--root <repo-dir>]

import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { isMainModule } from "./is-main-module.mjs";

/** Repository root, derived from this file's location (scripts/internal/). */
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const README = "README.md";
export const ACTIVITY_BAR = "src/components/ActivityBar/ActivityBar.tsx";
export const SSH_BACKEND = "core/src/backends/ssh/mod.rs";
export const KEYBINDINGS = "src/services/keybindings.ts";

/**
 * README shortcut-table rows → the binding actions they describe, in column
 * order (`Next / previous tab` lists next-tab, then prev-tab). `null` marks a
 * row that is not a configurable app action (Monaco's built-in save).
 */
export const SHORTCUT_ROWS = {
  "New local terminal": ["new-terminal"],
  "Close active tab": ["close-tab"],
  "Next / previous tab": ["next-tab", "prev-tab"],
  "Command palette": ["command-palette"],
  "Find in terminal": ["find-in-terminal"],
  "Jump to previous / next prompt": ["jump-prev-prompt", "jump-next-prompt"],
  "Split right / split down": ["split-right", "split-down"],
  "Toggle sidebar": ["toggle-sidebar"],
  "Open settings": ["open-settings"],
  "Show all keyboard shortcuts": ["show-shortcuts"],
  "Save file (in editor)": null,
};

// --- Markdown helpers -------------------------------------------------------

/**
 * The lines of a `###`/`##` section, up to the next heading of the same or a
 * higher level.
 *
 * @param {string} text - Markdown.
 * @param {string} heading - the heading line, e.g. `### Keyboard Shortcuts`.
 * @returns {string[] | null} the section's body lines, or null when missing.
 */
export function sectionLines(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const level = heading.match(/^#+/)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    const m = line.match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
    body.push(line);
  }
  return body;
}

/**
 * Split a prose list (`A, B (note), C and D`) into its items.
 *
 * @param {string} list - the list text.
 * @returns {string[]}
 */
export function parseProseList(list) {
  return list
    .replace(/\s*\([^)]*\)/g, "")
    .split(/,\s*(?:and\s+)?|\s+and\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Report the differences between two label lists.
 *
 * @param {string} what - what is being compared, for the message.
 * @param {string[]} readme - what README.md says.
 * @param {string[]} code - what the code says.
 * @param {string} source - the code file, for the message.
 * @returns {string[]} problems.
 */
function diffLists(what, readme, code, source) {
  const problems = [];
  for (const item of code) {
    if (!readme.includes(item)) problems.push(`${README}: ${what} misses "${item}" (in ${source})`);
  }
  for (const item of readme) {
    if (!code.includes(item)) {
      problems.push(`${README}: ${what} lists "${item}", which ${source} does not have`);
    }
  }
  return problems;
}

// --- 1. Activity Bar ----------------------------------------------------------

/**
 * Parse the ActivityBar item definitions.
 *
 * @param {string} source - ActivityBar.tsx.
 * @returns {{ label: string, experimental: boolean }[]}
 */
export function parseActivityBarItems(source) {
  const re =
    /\{\s*view:\s*"[^"]+",\s*icon:\s*\w+,\s*label:\s*"([^"]+)"(,\s*experimental:\s*true)?/g;
  return [...source.matchAll(re)].map((m) => ({ label: m[1], experimental: Boolean(m[2]) }));
}

/**
 * Check the README's "Activity Bar" bullet.
 *
 * @param {string} readme - README.md.
 * @param {string} source - ActivityBar.tsx.
 * @returns {string[]} problems.
 */
export function checkActivityBar(readme, source) {
  const items = parseActivityBarItems(source);
  if (items.length === 0)
    return [`${ACTIVITY_BAR}: no ActivityBar items found — update the parser`];
  const bullet = readme.split(/\r?\n/).find((l) => l.startsWith("- **Activity Bar**"));
  if (!bullet) return [`${README}: no "- **Activity Bar**" bullet found`];
  const always = bullet.match(/sidebar views: ([^.]+)\./);
  const experimental = bullet.match(/also shows ([^.]+)\./);
  if (!always || !experimental) {
    return [
      `${README}: the Activity Bar bullet must name its views as "sidebar views: A, B and C." ` +
        `and the experimental ones as "it also shows D and E."`,
    ];
  }
  const label = (exp) => items.filter((i) => i.experimental === exp).map((i) => i.label);
  return [
    ...diffLists("Activity Bar views", parseProseList(always[1]), label(false), ACTIVITY_BAR),
    ...diffLists(
      "experimental Activity Bar views",
      parseProseList(experimental[1]),
      label(true),
      ACTIVITY_BAR
    ),
  ];
}

// --- 2. SSH authentication methods -------------------------------------------

/**
 * Parse the SSH `authMethod` select options and default.
 *
 * @param {string} source - core/src/backends/ssh/mod.rs.
 * @returns {{ options: { value: string, label: string }[], defaultLabel: string | null } | null}
 */
export function parseAuthMethods(source) {
  const start = source.indexOf('key: "authMethod".to_string()');
  if (start === -1) return null;
  const rest = source.slice(start);
  const block = rest.match(/options:\s*vec!\[([\s\S]*?)\n\s*\],/);
  if (!block) return null;
  const optionRe =
    /SelectOption\s*\{\s*value:\s*("([^"]*)"|[\w:]+)(?:\s*\.to_string\(\))?,\s*label:\s*"([^"]+)"/g;
  const options = [...block[1].matchAll(optionRe)].map((m) => ({
    value: m[2] ?? m[1],
    label: m[3],
  }));
  const def = rest.match(/default:\s*Some\(serde_json::json!\("([^"]+)"\)\)/);
  const defaultLabel = options.find((o) => def && o.value === def[1])?.label ?? null;
  return { options, defaultLabel };
}

/**
 * Check the README's "Authentication Methods" bullets.
 *
 * @param {string} readme - README.md.
 * @param {string} source - core/src/backends/ssh/mod.rs.
 * @returns {string[]} problems.
 */
export function checkAuthMethods(readme, source) {
  const parsed = parseAuthMethods(source);
  if (!parsed || parsed.options.length === 0) {
    return [`${SSH_BACKEND}: no authMethod select options found — update the parser`];
  }
  const lines = sectionLines(readme, "### Authentication Methods");
  if (!lines) return [`${README}: no "### Authentication Methods" section found`];
  const bullets = lines
    .map((l) => l.match(/^- \*\*(.+?)\*\*(\s*\(default\))?/))
    .filter(Boolean)
    .map((m) => ({ label: m[1], isDefault: Boolean(m[2]) }));
  const problems = diffLists(
    "Authentication Methods",
    bullets.map((b) => b.label),
    parsed.options.map((o) => o.label),
    SSH_BACKEND
  );
  const marked = bullets.filter((b) => b.isDefault).map((b) => b.label);
  if (parsed.defaultLabel && (marked.length !== 1 || marked[0] !== parsed.defaultLabel)) {
    problems.push(
      `${README}: Authentication Methods marks ${marked.length ? `"${marked.join('", "')}"` : "nothing"} ` +
        `as (default), but ${SSH_BACKEND} defaults to "${parsed.defaultLabel}"`
    );
  }
  return problems;
}

// --- 3. Keyboard shortcuts ----------------------------------------------------

/**
 * Return the balanced `{…}` / `[…]` literal starting at `text[start]`,
 * skipping over string literals and `//` line comments.
 *
 * @param {string} text - source text.
 * @param {number} start - index of the opening bracket.
 * @returns {string}
 */
function balanced(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** `{ key: "x", meta: true, ... }` → a KeyCombo. */
function parseCombo(literal) {
  const key = literal.match(/key:\s*("(?:[^"\\]|\\.)*")/);
  if (!key) return undefined;
  const combo = { key: JSON.parse(key[1]) };
  for (const flag of ["ctrl", "shift", "alt", "meta"]) {
    if (new RegExp(`\\b${flag}:\\s*true`).test(literal)) combo[flag] = true;
  }
  return combo;
}

/**
 * Parse one binding field: `null`, a combo, a chord/alternates array, or
 * `undefined` when the field is absent or not a literal (an identifier).
 */
function parseField(chunk, name) {
  const m = chunk.match(new RegExp(`\\b${name}:\\s*`));
  if (!m) return undefined;
  const at = m.index + m[0].length;
  if (chunk.startsWith("null", at)) return null;
  const open = chunk[at];
  if (open !== "{" && open !== "[") return undefined;
  const literal = balanced(chunk, at);
  if (open === "{") return parseCombo(literal);
  const combos = [];
  for (let i = 1; i < literal.length; i++) {
    if (literal[i] === '"') {
      for (i++; literal[i] !== '"'; i++) if (literal[i] === "\\") i++;
    } else if (literal[i] === "{") {
      const inner = balanced(literal, i);
      combos.push(parseCombo(inner));
      i += inner.length - 1;
    }
  }
  return combos;
}

/**
 * Parse DEFAULT_BINDINGS from keybindings.ts.
 *
 * @param {string} source - src/services/keybindings.ts.
 * @returns {Map<string, { macDefault, winLinuxDefault, macAlternates, winLinuxAlternates }>}
 */
export function parseBindings(source) {
  const bindings = new Map();
  const start = source.indexOf("export const DEFAULT_BINDINGS");
  if (start === -1) return bindings;
  const arrayStart = source.indexOf("[", source.indexOf("=", start));
  const body = balanced(source, arrayStart)
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  // `action:` is a string literal or a constant (`RELEASE_CHORD_ACTION`).
  const constant = (name) =>
    source.match(new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`))?.[1] ?? name;
  for (const chunk of body.split(/(?=\{\s*action:\s*["\w])/).slice(1)) {
    const m = chunk.match(/action:\s*(?:"([^"]+)"|(\w+))/);
    const action = m[1] ?? constant(m[2]);
    bindings.set(action, {
      macDefault: parseField(chunk, "macDefault"),
      winLinuxDefault: parseField(chunk, "winLinuxDefault"),
      macAlternates: parseField(chunk, "macAlternates"),
      winLinuxAlternates: parseField(chunk, "winLinuxAlternates"),
    });
  }
  return bindings;
}

const KEY_DISPLAY = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};
const MODIFIERS = ["Cmd", "Ctrl", "Alt", "Shift"];

/** Order-insensitive canonical form of one combo (`Shift+Cmd+p` → `Cmd+Shift+P`). */
export function canonicalCombo(text) {
  const parts = text.split("+");
  const key = parts.length > 1 && parts.at(-1) === "" ? "+" : parts.pop();
  const mods = MODIFIERS.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** A KeyCombo or chord in the same canonical form. */
export function formatBinding(binding) {
  const one = (c) => {
    const mods = [c.meta && "Cmd", c.ctrl && "Ctrl", c.alt && "Alt", c.shift && "Shift"];
    const key = KEY_DISPLAY[c.key] ?? c.key;
    return [...mods.filter(Boolean), key.length === 1 ? key.toUpperCase() : key].join("+");
  };
  return Array.isArray(binding) ? binding.map(one).join(" ") : one(binding);
}

/**
 * Parse a README shortcut cell (`` `Cmd+P` / `Cmd+Shift+P` ``, `` `Cmd+K` `Cmd+S` ``)
 * into its alternatives; adjacent code spans form one chord.
 *
 * @param {string} cell - the table cell.
 * @returns {string[]} canonical alternatives.
 */
export function parseShortcutCell(cell) {
  const alternatives = [[]];
  let last = 0;
  for (const m of cell.matchAll(/(`+)\s?(.+?)\s?\1(?!`)/g)) {
    if (cell.slice(last, m.index).includes("/")) alternatives.push([]);
    alternatives.at(-1).push(canonicalCombo(m[2]));
    last = m.index + m[0].length;
  }
  return alternatives.filter((a) => a.length).map((a) => a.join(" "));
}

/**
 * Check the README's "Keyboard Shortcuts" table.
 *
 * @param {string} readme - README.md.
 * @param {string} source - src/services/keybindings.ts.
 * @returns {string[]} problems.
 */
export function checkShortcuts(readme, source) {
  const bindings = parseBindings(source);
  if (bindings.size === 0) return [`${KEYBINDINGS}: no DEFAULT_BINDINGS found — update the parser`];
  const lines = sectionLines(readme, "### Keyboard Shortcuts");
  if (!lines) return [`${README}: no "### Keyboard Shortcuts" section found`];
  const rows = lines
    .filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim())
    )
    .slice(1);
  const problems = [];
  for (const [label, mac, other] of rows) {
    if (!(label in SHORTCUT_ROWS)) {
      problems.push(
        `${README}: shortcut row "${label}" is unknown — map it to its actions in ` +
          `SHORTCUT_ROWS (scripts/internal/check-readme-parity.mjs)`
      );
      continue;
    }
    const actions = SHORTCUT_ROWS[label];
    if (actions === null) continue;
    for (const [column, cell, def, alt] of [
      ["macOS", mac, "macDefault", "macAlternates"],
      ["Windows / Linux", other, "winLinuxDefault", "winLinuxAlternates"],
    ]) {
      const expected = [];
      for (const action of actions) {
        const b = bindings.get(action);
        if (!b || !b[def]) {
          problems.push(
            `${README}: "${label}" cites \`${action}\`, which has no ${def} in ${KEYBINDINGS}`
          );
          continue;
        }
        expected.push(formatBinding(b[def]), ...(b[alt] ?? []).map(formatBinding));
      }
      const actual = parseShortcutCell(cell);
      if (expected.join(" / ") !== actual.join(" / ")) {
        problems.push(
          `${README}: "${label}" (${column}) says ${actual.join(" / ") || "nothing"}, ` +
            `but ${KEYBINDINGS} defaults to ${expected.join(" / ")}`
        );
      }
    }
  }
  return problems;
}

// --- Repo entry point ---------------------------------------------------------

/**
 * Run every parity check against the files under `root`.
 *
 * @param {string} root - repository root.
 * @returns {string[]} problems.
 */
export function checkRepo(root) {
  const read = (rel) => {
    const abs = path.join(root, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8") : null;
  };
  const files = [README, ACTIVITY_BAR, SSH_BACKEND, KEYBINDINGS];
  const missing = files.filter((f) => read(f) === null);
  if (missing.length) return missing.map((f) => `${f} does not exist`);
  const readme = read(README);
  return [
    ...checkActivityBar(readme, read(ACTIVITY_BAR)),
    ...checkAuthMethods(readme, read(SSH_BACKEND)),
    ...checkShortcuts(readme, read(KEYBINDINGS)),
  ];
}

// CLI mode.
if (isMainModule(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag !== -1 ? path.resolve(process.argv[rootFlag + 1]) : DEFAULT_ROOT;
  const problems = checkRepo(root);
  if (problems.length > 0) {
    console.error("README / app drift (see scripts/internal/check-readme-parity.mjs):");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("README.md matches the Activity Bar, SSH auth methods and default shortcuts.");
}
