export type SettingsCategory =
  | "general"
  | "appearance"
  | "terminal"
  | "security"
  | "external-files";

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
  { id: "security", label: "Security" },
  { id: "external-files", label: "External Files" },
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
