export type SettingsCategory =
  | "general"
  | "appearance"
  | "terminal"
  | "keyboard"
  | "security"
  | "external-files"
  | "editor"
  | "portable";

export interface CategoryDefinition {
  id: SettingsCategory;
  label: string;
}

export interface SettingDefinition {
  id: string;
  label: string;
  description: string;
  category: SettingsCategory;
  keywords: string[];
}

export const CATEGORIES: CategoryDefinition[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "keyboard", label: "Keyboard" },
  { id: "security", label: "Security" },
  { id: "external-files", label: "External Files" },
  { id: "editor", label: "Editor" },
  { id: "portable", label: "Portable Mode" },
];

export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    id: "defaultUser",
    label: "Default User",
    description: "Default username for new SSH connections",
    category: "general",
    keywords: ["username", "ssh", "login"],
  },
  {
    id: "defaultSshKeyPath",
    label: "Default SSH Key Path",
    description: "Default private key path for SSH key authentication",
    category: "general",
    keywords: ["key", "ssh", "identity", "private key", "authentication"],
  },
  {
    id: "defaultShell",
    label: "Default Shell",
    description: "Default shell for new local terminal sessions",
    category: "general",
    keywords: ["shell", "bash", "zsh", "powershell", "terminal"],
  },
  {
    id: "theme",
    label: "Theme",
    description: "Application color theme",
    category: "appearance",
    keywords: ["dark", "light", "color", "mode"],
  },
  {
    id: "fontFamily",
    label: "Font Family",
    description: "Terminal font family",
    category: "appearance",
    keywords: ["font", "typeface", "monospace", "nerd font"],
  },
  {
    id: "fontSize",
    label: "Font Size",
    description: "Terminal font size in pixels",
    category: "appearance",
    keywords: ["font", "size", "text", "pixels"],
  },
  {
    id: "defaultHorizontalScrolling",
    label: "Default Horizontal Scrolling",
    description: "Enable horizontal scrolling for new terminals by default",
    category: "terminal",
    keywords: ["scroll", "horizontal", "wrap", "overflow"],
  },
  {
    id: "scrollbackBuffer",
    label: "Scrollback Buffer",
    description: "Number of lines to keep in the terminal scrollback buffer",
    category: "terminal",
    keywords: ["buffer", "history", "lines", "scroll"],
  },
  {
    id: "cursorStyle",
    label: "Cursor Style",
    description: "Terminal cursor shape",
    category: "terminal",
    keywords: ["cursor", "block", "underline", "bar", "caret"],
  },
  {
    id: "cursorBlink",
    label: "Cursor Blink",
    description: "Whether the terminal cursor blinks",
    category: "terminal",
    keywords: ["cursor", "blink", "animation", "flash"],
  },
  {
    id: "rightClickBehavior",
    label: "Right-Click Behavior",
    description: "Terminal right-click action: context menu or quick copy/paste",
    category: "terminal",
    keywords: ["right-click", "context menu", "copy", "paste", "quick action", "mouse"],
  },
  {
    id: "keybindings",
    label: "Keyboard Shortcuts",
    description: "Customize keyboard shortcuts and key bindings",
    category: "keyboard",
    keywords: ["keyboard", "shortcut", "keybinding", "hotkey", "key combination", "binding"],
  },
  {
    id: "credentialStorageMode",
    label: "Credential Storage Mode",
    description: "How connection passwords and keys are stored",
    category: "security",
    keywords: ["credential", "keychain", "master password", "security", "encryption", "password"],
  },
  {
    id: "credentialAutoLockMinutes",
    label: "Auto-Lock Timeout",
    description: "Lock the master password credential store after inactivity",
    category: "security",
    keywords: ["auto-lock", "timeout", "lock", "inactivity", "minutes"],
  },
  {
    id: "fileLanguageMappings",
    label: "File Type Mappings",
    description: "Map filenames and extensions to syntax highlighting languages",
    category: "editor",
    keywords: ["syntax", "highlight", "language", "filetype", "extension", "mapping", "monaco"],
  },
  {
    id: "installedLanguagePackages",
    label: "Language Packages",
    description:
      "Install additional syntax highlighting packages from Shiki's TextMate grammar library",
    category: "editor",
    keywords: [
      "language",
      "package",
      "syntax",
      "highlight",
      "grammar",
      "textmate",
      "shiki",
      "install",
      "astro",
      "svelte",
      "zig",
      "dart",
      "elixir",
    ],
  },
  {
    id: "customLanguageGrammars",
    label: "Custom Language Grammars",
    description: "Import custom TextMate grammar files (.tmLanguage.json) for your own languages",
    category: "editor",
    keywords: [
      "custom",
      "language",
      "grammar",
      "textmate",
      "tmLanguage",
      "import",
      "syntax",
      "highlight",
    ],
  },
  {
    id: "portableMode",
    label: "Portable Mode",
    description: "Run termiHub from a USB drive or any directory without system installation",
    category: "portable",
    keywords: [
      "portable",
      "usb",
      "travel",
      "self-contained",
      "data directory",
      "marker",
      "no install",
    ],
  },
  {
    id: "portableMigration",
    label: "Config Migration",
    description: "Export or import configuration between installed and portable mode",
    category: "portable",
    keywords: ["export", "import", "migrate", "copy", "transfer", "backup", "portable"],
  },
];

/**
 * Filter settings by a search query. Matches against label, description,
 * category, and keywords (case-insensitive).
 */
export function filterSettings(query: string): SettingDefinition[] {
  const q = query.toLowerCase().trim();
  if (!q) return SETTINGS_REGISTRY;

  return SETTINGS_REGISTRY.filter((setting) => {
    const haystack = [setting.label, setting.description, setting.category, ...setting.keywords]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Return the set of categories that contain at least one matching setting.
 */
export function getMatchingCategories(query: string): Set<SettingsCategory> {
  const matched = filterSettings(query);
  return new Set(matched.map((s) => s.category));
}
