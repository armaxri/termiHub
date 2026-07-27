export type SettingsCategory =
  | "general"
  | "appearance"
  | "terminal"
  | "shell-integration"
  | "keyboard"
  | "security"
  | "external-files"
  | "editor"
  | "plugins"
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
  { id: "shell-integration", label: "Shell Integration" },
  { id: "keyboard", label: "Keyboard" },
  { id: "security", label: "Security" },
  { id: "external-files", label: "External Files" },
  { id: "editor", label: "Editor" },
  { id: "plugins", label: "Plugins" },
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
    keywords: ["dark", "light", "color", "mode", "custom", "theme editor", "palette"],
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
    id: "defaultLineEnding",
    label: "Line Ending (Enter & Paste)",
    description: "Line ending sent on Enter and used to normalize pasted text",
    category: "terminal",
    keywords: [
      "line ending",
      "newline",
      "crlf",
      "lf",
      "cr",
      "enter",
      "return",
      "paste",
      "carriage return",
      "windows",
      "putty",
    ],
  },
  {
    id: "rightClickBehavior",
    label: "Right-Click Behavior",
    description: "Terminal right-click action: context menu or quick copy/paste",
    category: "terminal",
    keywords: ["right-click", "context menu", "copy", "paste", "quick action", "mouse"],
  },
  {
    id: "askOpenSavedFileInTab",
    label: "Open Saved File in Tab",
    description: "Offer to open terminal content in an editor tab after saving it to a file",
    category: "terminal",
    keywords: ["save", "file", "tab", "editor", "monaco", "terminal", "open", "prompt"],
  },
  {
    id: "syntaxHighlighting",
    label: "Syntax Highlighting",
    description: "Colorize errors, URLs, paths, IPs, and other patterns in plain terminal output",
    category: "terminal",
    keywords: [
      "syntax",
      "highlight",
      "highlighting",
      "colorize",
      "color",
      "error",
      "warning",
      "url",
      "path",
      "ip",
      "regex",
      "rule",
      "output",
      "terminal",
    ],
  },
  {
    id: "shellIntegrationRegistration",
    label: "Context Menu Registration",
    description: "Register or remove the file-manager right-click integration",
    category: "shell-integration",
    keywords: [
      "shell integration",
      "context menu",
      "right-click",
      "explorer",
      "finder",
      "nautilus",
      "register",
      "reinstall",
      "uninstall",
      "open in termihub",
    ],
  },
  {
    id: "shellIntegrationEntries",
    label: "Quick-Access Entries",
    description: "Configure the entries shown in your file manager's right-click menu",
    category: "shell-integration",
    keywords: ["entry", "quick access", "context menu", "shell", "connection", "picker", "reorder"],
  },
  {
    id: "shellIntegrationFallback",
    label: "Shell Integration Fallback",
    description: "What to open when no quick-access entry matches a request",
    category: "shell-integration",
    keywords: ["fallback", "picker", "default shell", "shell integration", "new window"],
  },
  {
    id: "shellIntegrationLinux",
    label: "Linux File Manager Integrations",
    description: "Install Nautilus, KDE, or Thunar file-manager integrations on Linux",
    category: "shell-integration",
    keywords: ["linux", "nautilus", "kde", "dolphin", "thunar", "file manager", "service menu"],
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
    id: "rdpTrustedCertificates",
    label: "Remembered RDP Certificates",
    description: "Review and revoke RDP server certificates you chose to trust",
    category: "security",
    keywords: [
      "rdp",
      "certificate",
      "cert",
      "trust",
      "fingerprint",
      "remote desktop",
      "revoke",
      "forget",
      "known hosts",
      "mitm",
    ],
  },
  {
    id: "sshTrustedHostKeys",
    label: "Remembered SSH Host Keys",
    description: "Review and revoke SSH host keys you chose to trust",
    category: "security",
    keywords: [
      "ssh",
      "host key",
      "hostkey",
      "trust",
      "fingerprint",
      "sha256",
      "revoke",
      "forget",
      "known hosts",
      "known_hosts",
      "mitm",
    ],
  },
  {
    id: "workflowLocalProcess",
    label: "Workflow Local Process Execution",
    description:
      "Allow workflows to run local programs on this computer, and manage which programs are allowed",
    category: "security",
    keywords: [
      "workflow",
      "local process",
      "run-local-process",
      "execute",
      "program",
      "allowlist",
      "authorize",
      "security",
      "spawn",
    ],
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
    id: "serialPortScanPrefixes",
    label: "Serial Port Scan Prefixes",
    description:
      "Linux /dev prefixes scanned to discover serial ports that the system library may not enumerate (e.g. ttyAMA* on Raspberry Pi)",
    category: "general",
    keywords: [
      "serial",
      "port",
      "tty",
      "uart",
      "linux",
      "raspberry pi",
      "embedded",
      "device",
      "prefix",
      "scan",
      "ttyAMA",
      "ttyS",
      "ttyUSB",
    ],
  },
  {
    id: "confirmCloseTabOnShortcut",
    label: "Confirm Close Tab on Shortcut",
    description: "Ask for confirmation when closing a tab via keyboard shortcut",
    category: "general",
    keywords: [
      "confirm",
      "close",
      "tab",
      "shortcut",
      "keyboard",
      "dialog",
      "ctrl+w",
      "cmd+w",
      "prompt",
    ],
  },
  {
    id: "confirmCloseLiveSession",
    label: "Confirm Closing a Live Session",
    description:
      "Ask for confirmation before closing a tab or split panel that holds a live session",
    category: "general",
    keywords: [
      "confirm",
      "close",
      "tab",
      "panel",
      "split",
      "live",
      "session",
      "ssh",
      "serial",
      "shell",
      "middle-click",
      "kill",
      "prompt",
      "dialog",
    ],
  },
  {
    id: "confirmCloseAttachedTab",
    label: "Notify When Closing a Persistent-Session Tab",
    description:
      "Show a one-time notice that a persistent session keeps running when its tab is closed",
    category: "general",
    keywords: [
      "confirm",
      "notice",
      "close",
      "tab",
      "persistent",
      "session",
      "background",
      "attached",
      "detach",
      "running",
      "prompt",
      "dialog",
    ],
  },
  {
    id: "warnLargePortScan",
    label: "Warn Before a Large Port Scan",
    description:
      "Show a warning before starting a Port Scanner scan that probes a very large number of host/port combinations",
    category: "general",
    keywords: [
      "warn",
      "port",
      "scan",
      "scanner",
      "large",
      "network",
      "confirm",
      "prompt",
      "dialog",
      "probe",
    ],
  },
  {
    id: "warnLargePingSweep",
    label: "Warn Before a Large Ping Sweep",
    description:
      "Show a warning before starting a Ping Sweep across a very large number of hosts (e.g. a wide CIDR block)",
    category: "general",
    keywords: [
      "warn",
      "ping",
      "sweep",
      "subnet",
      "range",
      "cidr",
      "large",
      "network",
      "confirm",
      "prompt",
      "dialog",
      "host",
    ],
  },
  {
    id: "experimentalFeaturesEnabled",
    label: "Allow Experimental Features",
    description:
      "Show experimental features that are not guaranteed to be released or long-term supported",
    category: "general",
    keywords: ["experimental", "beta", "preview", "unstable", "hidden", "features", "labs"],
  },
  {
    id: "frontendPluginsEnabled",
    label: "Enable Frontend (JavaScript) Plugins",
    description:
      "Experimental: run plugin-provided JavaScript (protocol parsers, status-bar widgets) in the app. Off by default — these plugins run with full access and weak isolation.",
    category: "plugins",
    keywords: [
      "plugin",
      "frontend",
      "javascript",
      "experimental",
      "security",
      "parser",
      "widget",
      "untrusted",
      "sandbox",
    ],
  },
  {
    id: "restoreLastSessionOnStartup",
    label: "Restore Last Session on Startup",
    description:
      "Never, ask, or always reopen the tabs and layout from your previous session when the app starts",
    category: "general",
    keywords: [
      "restore",
      "session",
      "startup",
      "reopen",
      "tabs",
      "layout",
      "persist",
      "remember",
      "last",
      "previous",
      "ask",
      "always",
      "never",
      "mode",
    ],
  },
  {
    id: "sessionHistoryEnabled",
    label: "Auto-Save Sessions to History",
    description: "Record every session opened so it can be reconnected from Recent Sessions",
    category: "general",
    keywords: ["session", "history", "recent", "record", "auto-save", "mobaxterm", "quick connect"],
  },
  {
    id: "sessionHistoryLimit",
    label: "Session History Limit",
    description: "Maximum number of recent sessions to keep before the oldest is evicted",
    category: "general",
    keywords: ["session", "history", "limit", "recent", "max", "count", "evict"],
  },
  {
    id: "showRecentSessions",
    label: "Show Recent Sessions Panel",
    description: "Show the Recent Sessions sidebar panel and its activity-bar icon",
    category: "general",
    keywords: ["session", "history", "recent", "sidebar", "panel", "show", "hide"],
  },
  {
    id: "provideXServerAutomatically",
    label: "Provide X Server Automatically",
    description: "Start a local X server automatically for X11 forwarding",
    category: "general",
    keywords: ["x server", "x11", "xserver", "display", "vcxsrv", "forwarding", "gui"],
  },
  {
    id: "stopXServerWhenIdle",
    label: "Stop X Server When Idle",
    description: "Shut down the auto-provided X server when no connection uses it",
    category: "general",
    keywords: ["x server", "x11", "idle", "stop", "shutdown", "display"],
  },
  {
    id: "pluginSettings",
    label: "Plugin Settings",
    description: "Configure settings for installed plugins that declare them",
    category: "plugins",
    keywords: [
      "plugin",
      "plugins",
      "extension",
      "addon",
      "add-on",
      "settings",
      "configure",
      "manifest",
      "schema",
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
