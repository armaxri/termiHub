import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import {
  KEYBINDINGS,
  SHORTCUT_ROWS,
  canonicalCombo,
  checkActivityBar,
  checkAuthMethods,
  checkRepo,
  checkShortcuts,
  parseActivityBarItems,
  parseAuthMethods,
  parseBindings,
  parseProseList,
  parseShortcutCell,
} from "./check-readme-parity.mjs";
import { DEFAULT_BINDINGS } from "../../src/services/keybindings.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ACTIVITY_SRC = `
const REQUIRED_ITEMS = [{ view: "connections", icon: Network, label: "Connections" }];
const OPTIONAL_ITEMS = [
  { view: "files", icon: FolderOpen, label: "File Browser" },
  { view: "tunnels", icon: ArrowLeftRight, label: "SSH Tunnels", experimental: true },
  { view: "services", icon: Server, label: "Services", experimental: true },
];`;
const ACTIVITY_README =
  "- **Activity Bar** — icons for the sidebar views: Connections and File Browser. " +
  "With experimental features on, it also shows SSH Tunnels and Services (embedded servers). " +
  "At the bottom, the gear.";

const SSH_SRC = `
SettingsField {
    key: "authMethod".to_string(),
    field_type: FieldType::Select {
        options: vec![
            SelectOption {
                value: "key".to_string(),
                label: "SSH Key".to_string(),
            },
            SelectOption {
                value: keyboard_interactive::AUTH_METHOD_KEYBOARD_INTERACTIVE
                    .to_string(),
                label: "Keyboard-Interactive".to_string(),
            },
        ],
    },
    default: Some(serde_json::json!("key")),
}`;
const AUTH_README = [
  "### Authentication Methods",
  "",
  "- **SSH Key** (default) — a key file.",
  "- **Keyboard-Interactive** — prompts.",
  "",
  "**SSH Agent Forwarding** — not a method.",
  "",
  "### Next",
  "- **Ignored** — another section.",
].join("\n");

const KEY_SRC = `
export const DEFAULT_BINDINGS: KeyBinding[] = [
  {
    action: "split-right",
    macDefault: { key: "\\\\", meta: true },
    // a comment mentioning macDefault: { key: "x" }
    winLinuxDefault: { key: "\\\\", alt: true, shift: true },
  },
  {
    action: "command-palette",
    macDefault: { key: "p", meta: true },
    macAlternates: [{ key: "P", meta: true, shift: true }],
    winLinuxDefault: { key: "P", ctrl: true, shift: true },
  },
  {
    action: "show-shortcuts",
    macDefault: [
      { key: "k", meta: true },
      { key: "s", meta: true },
    ],
    winLinuxDefault: { key: "F1" },
  },
  {
    action: "next-tab-group",
    macDefault: { key: "]", meta: true, shift: true },
    winLinuxDefault: null,
  },
  { action: "release", macDefault: DEFAULT_RELEASE_CHORD, winLinuxDefault: DEFAULT_RELEASE_CHORD },
];`;
const KEY_README = [
  "### Keyboard Shortcuts",
  "",
  "| Action | macOS | Windows / Linux |",
  "| ------ | ----- | --------------- |",
  "| Command palette | `Cmd+P` / `Cmd+Shift+P` | `Ctrl+Shift+P` |",
  "| Show all keyboard shortcuts | `Cmd+K` `Cmd+S` | `F1` |",
  "| Save file (in editor) | `Cmd+S` | `Ctrl+S` |",
  "",
  "Prose after the table.",
].join("\n");

describe("parseProseList", () => {
  it("splits commas and 'and', dropping parentheticals", () => {
    expect(parseProseList("A, B (note), C and D")).toEqual(["A", "B", "C", "D"]);
    expect(parseProseList("A, B, and C")).toEqual(["A", "B", "C"]);
  });
});

describe("Activity Bar", () => {
  it("parses items with their experimental flag", () => {
    expect(parseActivityBarItems(ACTIVITY_SRC)).toEqual([
      { label: "Connections", experimental: false },
      { label: "File Browser", experimental: false },
      { label: "SSH Tunnels", experimental: true },
      { label: "Services", experimental: true },
    ]);
  });
  it("passes when the README matches", () => {
    expect(checkActivityBar(ACTIVITY_README, ACTIVITY_SRC)).toEqual([]);
  });
  it("names a view the README is missing and one it invents", () => {
    const readme = ACTIVITY_README.replace(
      "Connections and File Browser",
      "Connections and Macros"
    );
    expect(checkActivityBar(readme, ACTIVITY_SRC)).toEqual([
      `README.md: Activity Bar views misses "File Browser" (in src/components/ActivityBar/ActivityBar.tsx)`,
      `README.md: Activity Bar views lists "Macros", which src/components/ActivityBar/ActivityBar.tsx does not have`,
    ]);
  });
  it("catches an experimental flag flip", () => {
    const src = ACTIVITY_SRC.replace('label: "Services", experimental: true', 'label: "Services"');
    expect(checkActivityBar(ACTIVITY_README, src)).toHaveLength(2);
  });
});

describe("SSH authentication methods", () => {
  it("parses options, including a const value, and the default", () => {
    expect(parseAuthMethods(SSH_SRC)).toEqual({
      options: [
        { value: "key", label: "SSH Key" },
        {
          value: "keyboard_interactive::AUTH_METHOD_KEYBOARD_INTERACTIVE",
          label: "Keyboard-Interactive",
        },
      ],
      defaultLabel: "SSH Key",
    });
  });
  it("passes when the README matches", () => {
    expect(checkAuthMethods(AUTH_README, SSH_SRC)).toEqual([]);
  });
  it("flags a missing method and a wrong default", () => {
    const readme = AUTH_README.replace("- **Keyboard-Interactive** — prompts.\n", "").replace(
      " (default)",
      ""
    );
    expect(checkAuthMethods(readme, SSH_SRC)).toEqual([
      `README.md: Authentication Methods misses "Keyboard-Interactive" (in core/src/backends/ssh/mod.rs)`,
      `README.md: Authentication Methods marks nothing as (default), but core/src/backends/ssh/mod.rs defaults to "SSH Key"`,
    ]);
  });
});

describe("keyboard shortcuts", () => {
  it("parses literal bindings, chords, alternates, null and skips identifiers", () => {
    const b = parseBindings(KEY_SRC);
    expect(b.get("split-right").macDefault).toEqual({ key: "\\", meta: true });
    expect(b.get("command-palette").macAlternates).toEqual([{ key: "P", meta: true, shift: true }]);
    expect(b.get("show-shortcuts").macDefault).toEqual([
      { key: "k", meta: true },
      { key: "s", meta: true },
    ]);
    expect(b.get("next-tab-group")).toMatchObject({
      macDefault: { key: "]", meta: true, shift: true },
      winLinuxDefault: null,
    });
    expect(b.get("release").macDefault).toBeUndefined();
  });

  it("canonicalises modifier order and key case", () => {
    expect(canonicalCombo("Shift+Alt+\\")).toBe("Alt+Shift+\\");
    expect(canonicalCombo("Cmd+p")).toBe("Cmd+P");
  });

  it("parses cells into alternatives and chords", () => {
    expect(parseShortcutCell("`Cmd+P` / `Cmd+Shift+P`")).toEqual(["Cmd+P", "Cmd+Shift+P"]);
    expect(parseShortcutCell("`Cmd+K` `Cmd+S`")).toEqual(["Cmd+K Cmd+S"]);
    expect(parseShortcutCell("`` Cmd+Shift+` ``")).toEqual(["Cmd+Shift+`"]);
  });

  it("passes when the table matches", () => {
    expect(checkShortcuts(KEY_README, KEY_SRC)).toEqual([]);
  });

  it("names the row and column that drifted", () => {
    const readme = KEY_README.replace("| `Ctrl+Shift+P` |", "| `Ctrl+P` |");
    expect(checkShortcuts(readme, KEY_SRC)).toEqual([
      `README.md: "Command palette" (Windows / Linux) says Ctrl+P, but src/services/keybindings.ts defaults to Ctrl+Shift+P`,
    ]);
  });

  it("flags a row it has no mapping for", () => {
    const readme = KEY_README.replace("Save file (in editor)", "Do a thing");
    expect(checkShortcuts(readme, KEY_SRC)[0]).toMatch(/shortcut row "Do a thing" is unknown/);
  });
});

describe("real repository", () => {
  it("the keybinding parser agrees with the real DEFAULT_BINDINGS", () => {
    const parsed = parseBindings(readFileSync(path.join(ROOT, KEYBINDINGS), "utf8"));
    const mapped = Object.values(SHORTCUT_ROWS).flat().filter(Boolean);
    for (const action of mapped) {
      const real = DEFAULT_BINDINGS.find((b) => b.action === action);
      expect(real, action).toBeDefined();
      const p = parsed.get(action);
      for (const field of [
        "macDefault",
        "winLinuxDefault",
        "macAlternates",
        "winLinuxAlternates",
      ]) {
        expect(p[field], `${action}.${field}`).toEqual(real[field]);
      }
    }
    expect(parsed.size).toBe(DEFAULT_BINDINGS.length);
  });

  it("README.md matches the Activity Bar, SSH auth methods and shortcut defaults", () => {
    expect(checkRepo(ROOT)).toEqual([]);
  });
});
