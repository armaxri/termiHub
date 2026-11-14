import { EXPERIMENTAL_SETTING_LABEL } from "@/utils/experimentalSetting";

export type SettingsCategory =
  | "general"
  | "appearance"
  | "terminal"
  | "serial"
  | "accessibility"
  | "shell-integration"
  | "keyboard"
  | "sessions"
  | "safety-prompts"
  | "x-server"
  | "security"
  | "external-files"
  | "monitoring"
  | "editor"
  | "plugins"
  | "backup"
  | "import"
  | "schedules"
  | "portable"
  | "updates";

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
  /**
   * Only searchable while experimental features are enabled, because the
   * setting belongs to a gated connection type (e.g. RDP, #5365).
   */
  experimental?: boolean;
}

/**
 * A heading in the Settings navigation (#5561). Nineteen flat categories did not
 * fit a 1280×800 window and gave rare pages the weight of General, so the nav
 * groups them; a `collapsible` group starts folded and opens on demand (and on
 * its own when one of its categories is active or matches a search).
 */
export interface CategoryGroupDefinition {
  id: string;
  label: string;
  categories: SettingsCategory[];
  collapsible?: boolean;
}

/** Navigation groups, in display order. Every category belongs to exactly one. */
export const CATEGORY_GROUPS: CategoryGroupDefinition[] = [
  {
    id: "general",
    label: "General",
    categories: ["general", "appearance", "accessibility", "keyboard", "updates"],
  },
  {
    id: "terminal",
    label: "Terminal",
    categories: ["terminal", "shell-integration", "sessions", "monitoring", "editor"],
  },
  { id: "connections", label: "Connections", categories: ["serial", "external-files"] },
  {
    id: "security",
    label: "Security and data",
    categories: ["security", "safety-prompts", "backup"],
  },
  {
    id: "advanced",
    label: "Advanced",
    categories: ["plugins", "import", "schedules", "portable", "x-server"],
    collapsible: true,
  },
];

/**
 * Every category in navigation order (group by group), so search results follow
 * the nav. Kept a literal: the system-test testid catalog reads its ids
 * (`tests/system/testid-templates.json`). `SettingsNav.groups.test.tsx` checks
 * it lists exactly the {@link CATEGORY_GROUPS} categories, in their order.
 */
export const CATEGORIES: CategoryDefinition[] = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "accessibility", label: "Accessibility" },
  { id: "keyboard", label: "Keyboard" },
  { id: "updates", label: "Updates" },
  { id: "terminal", label: "Terminal" },
  { id: "shell-integration", label: "File manager integration" },
  { id: "sessions", label: "Sessions" },
  { id: "monitoring", label: "Monitoring" },
  { id: "editor", label: "Editor" },
  { id: "serial", label: "Serial" },
  { id: "external-files", label: "External files" },
  { id: "security", label: "Security" },
  { id: "safety-prompts", label: "Safety prompts" },
  { id: "backup", label: "Backup & restore" },
  { id: "plugins", label: "Plugins" },
  { id: "import", label: "Import & migration" },
  { id: "schedules", label: "Schedules" },
  { id: "portable", label: "Portable mode" },
  { id: "x-server", label: "X server" },
];

/**
 * The Settings search index. Search is driven entirely by this list: a category
 * is mounted in search mode only when one of its entries matches, and a gated
 * panel shows a field only when that field's id is matched. To make a new
 * settings section searchable, give its category an entry here (and render it
 * from `SETTINGS_SECTIONS` in `SettingsPanel`); `settingsRegistryCoverage.test.ts`
 * fails if a navigable category or a `show()`-gated field has no entry.
 */
export const SETTINGS_REGISTRY: SettingDefinition[] = [
  {
    id: "defaultUser",
    label: "Default user",
    description: "Default username for new SSH connections",
    category: "general",
    keywords: ["username", "ssh", "login"],
  },
  {
    id: "defaultSshKeyPath",
    label: "Default SSH key path",
    description: "Default private key path for SSH key authentication",
    category: "general",
    keywords: ["key", "ssh", "identity", "private key", "authentication"],
  },
  {
    id: "defaultShell",
    label: "Default shell",
    description: "Default shell for new local terminal sessions",
    category: "general",
    keywords: ["shell", "bash", "zsh", "powershell", "terminal"],
  },
  {
    id: "defaultX11Forwarding",
    label: "X11 forwarding by default",
    description: "Pre-enable X11 forwarding for new SSH connections",
    category: "general",
    keywords: [
      "ssh",
      "defaults",
      "x11",
      "x server",
      "forwarding",
      "display",
      "gui",
      "new connection",
    ],
  },
  {
    id: "fileBrowser",
    label: "File browser",
    description: "Enable the SFTP file browser for SSH agent sessions",
    category: "general",
    // "advanced" / "external" keep the pre-#5786 home (External files ▸ Advanced) findable.
    keywords: [
      "file browser",
      "sftp",
      "files",
      "agent",
      "ssh",
      "remote",
      "defaults",
      "new connection",
      "advanced",
      "external",
    ],
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
    label: "Font family",
    description: "Terminal font family",
    category: "appearance",
    keywords: ["font", "typeface", "monospace", "nerd font"],
  },
  {
    id: "fontSize",
    label: "Font size",
    description: "Terminal font size in pixels",
    category: "appearance",
    keywords: ["font", "size", "text", "pixels"],
  },
  {
    id: "lineHeight",
    label: "Line height",
    description: "Terminal line height; use 1.0 for seamless box-drawing characters",
    category: "appearance",
    keywords: ["line height", "line spacing", "spacing", "leading", "font", "box-drawing"],
  },
  {
    id: "defaultHorizontalScrolling",
    label: "Default horizontal scrolling",
    description: "Enable horizontal scrolling for new terminals by default",
    category: "terminal",
    keywords: ["scroll", "horizontal", "wrap", "overflow"],
  },
  {
    id: "scrollbackBuffer",
    label: "Scrollback buffer",
    description: "Number of lines to keep in the terminal scrollback buffer",
    category: "terminal",
    keywords: ["buffer", "history", "lines", "scroll"],
  },
  {
    id: "cursorStyle",
    label: "Cursor style",
    description: "Terminal cursor shape",
    category: "terminal",
    keywords: ["cursor", "block", "underline", "bar", "caret"],
  },
  {
    id: "cursorBlink",
    label: "Cursor blink",
    description: "Whether the terminal cursor blinks",
    category: "terminal",
    keywords: ["cursor", "blink", "animation", "flash"],
  },
  {
    id: "defaultLineEnding",
    label: "Line ending",
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
    label: "Right-click behavior",
    description: "Terminal right-click action: context menu or quick copy/paste",
    category: "terminal",
    keywords: ["right-click", "context menu", "copy", "paste", "quick action", "mouse"],
  },
  {
    id: "terminalCommandDecorations",
    label: "Show command marks",
    description:
      "Show a success/failure mark next to each finished command (needs shell integration)",
    category: "terminal",
    keywords: [
      "osc 133",
      "command",
      "prompt",
      "exit code",
      "status",
      "success",
      "failure",
      "gutter",
      "decoration",
      "shell integration",
      "command marks",
      // The label before #5633.
      "command status marks",
    ],
  },
  {
    id: "defaultShellIntegration",
    label: "Add shell hook to new sessions automatically",
    description:
      "Turn the shell hook (OSC 133 command marks) on for new local, SSH and WSL connections",
    category: "terminal",
    keywords: [
      "ssh",
      "local",
      "wsl",
      "defaults",
      "command marks",
      // Earlier labels (before #5561 and #5633), so a search for them still lands here.
      "command marks (shell hook) by default",
      "command marks by default",
      "shell hook",
      "shell integration",
      "osc 133",
      "osc133",
      "new connection",
    ],
  },
  {
    id: "terminalInlineImages",
    label: "Inline images",
    description: "Render SIXEL and iTerm2 inline images in the terminal",
    category: "terminal",
    keywords: [
      "image",
      "images",
      "sixel",
      "iterm2",
      "imgcat",
      "img2sixel",
      "graphics",
      "picture",
      "inline",
      "osc 1337",
    ],
  },
  {
    id: "combineEmoji",
    label: "Combine emoji (experimental)",
    description: "Show emoji sequences (families, skin tones, flags) as one double-width glyph",
    category: "terminal",
    keywords: [
      "emoji",
      "grapheme",
      "zwj",
      "skin tone",
      "flag",
      "unicode",
      "width",
      "cluster",
      "experimental",
    ],
  },
  {
    id: "askOpenSavedFileInTab",
    label: "Open saved file in tab",
    description: "Offer to open terminal content in an editor tab after saving it to a file",
    category: "terminal",
    keywords: ["save", "file", "tab", "editor", "monaco", "terminal", "open", "prompt"],
  },
  {
    id: "screenReaderMode",
    label: "Screen reader mode",
    description: "Expose terminal output to assistive technology (screen readers)",
    category: "accessibility",
    keywords: [
      "screen reader",
      "accessibility",
      "a11y",
      "assistive",
      "aria",
      "voiceover",
      "nvda",
      "jaws",
      "narrator",
    ],
  },
  {
    id: "syntaxHighlighting",
    label: "Syntax highlighting",
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
    label: "Context menu registration",
    description: "Register or remove the file-manager right-click integration",
    category: "shell-integration",
    keywords: [
      "file manager integration",
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
    label: "Quick-access entries",
    description: "Configure the entries shown in your file manager's right-click menu",
    category: "shell-integration",
    keywords: ["entry", "quick access", "context menu", "shell", "connection", "picker", "reorder"],
  },
  {
    id: "shellIntegrationFallback",
    label: "File manager integration fallback",
    description: "What to open when no quick-access entry matches a request",
    category: "shell-integration",
    keywords: ["fallback", "picker", "default shell", "shell integration", "new window"],
  },
  {
    id: "shellIntegrationLinux",
    label: "Linux file manager integrations",
    description: "Install Nautilus, KDE, or Thunar file-manager integrations on Linux",
    category: "shell-integration",
    keywords: ["linux", "nautilus", "kde", "dolphin", "thunar", "file manager", "service menu"],
  },
  {
    id: "keybindings",
    label: "Keyboard shortcuts",
    description: "Customize keyboard shortcuts and key bindings",
    category: "keyboard",
    keywords: ["keyboard", "shortcut", "keybinding", "hotkey", "key combination", "binding"],
  },
  {
    id: "credentialStorageMode",
    label: "Credential storage mode",
    description: "How connection passwords and keys are stored",
    category: "security",
    keywords: ["credential", "keychain", "master password", "security", "encryption", "password"],
  },
  {
    id: "credentialAutoLockMinutes",
    label: "Auto-lock timeout",
    description: "Lock the master password credential store after inactivity",
    category: "security",
    keywords: [
      "auto-lock",
      "timeout",
      "lock",
      "inactivity",
      "minutes",
      "touch id",
      "windows hello",
      "biometric",
      "fingerprint",
      "unlock",
    ],
  },
  {
    id: "sharedCredentials",
    label: "Shared credentials",
    description:
      "Passwords and key passphrases shared by several connections, changed in one place",
    category: "security",
    keywords: [
      "shared",
      "credential",
      "named",
      "password",
      "passphrase",
      "rotate",
      "bastion",
      "reuse",
    ],
  },
  {
    id: "credentialVaultBackup",
    label: "Credential vault backup",
    description:
      "Export or import your saved credentials as an encrypted, passphrase-protected file",
    category: "security",
    keywords: [
      "credential",
      "vault",
      "export",
      "import",
      "backup",
      "restore",
      "migrate",
      "passphrase",
      "password",
      "encrypted",
    ],
  },
  {
    id: "rdpTrustedCertificates",
    label: "Remembered RDP certificates",
    description: "Review and revoke RDP server certificates you chose to trust",
    category: "security",
    experimental: true,
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
    label: "Remembered SSH host keys",
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
    label: "Workflow local process execution",
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
    id: "workspaceImportConfirmations",
    label: "Imported workspace confirmations",
    description:
      "See and revoke the imported workspace commands and connections confirmed on this machine",
    category: "security",
    keywords: [
      "workspace",
      "imported",
      "import",
      "allowlist",
      "confirm",
      "confirmation",
      "revoke",
      "trust",
      "command",
      "connection",
      "security",
    ],
  },
  {
    id: "fileLanguageMappings",
    label: "File type mappings",
    description: "Map filenames and extensions to syntax highlighting languages",
    category: "editor",
    keywords: ["syntax", "highlight", "language", "filetype", "extension", "mapping", "monaco"],
  },
  {
    id: "installedLanguagePackages",
    label: "Language packages",
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
    label: "Custom language grammars",
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
    label: "Serial port scan prefixes",
    description:
      "Linux /dev prefixes scanned to discover serial ports that the system library may not enumerate (e.g. ttyAMA* on Raspberry Pi)",
    category: "serial",
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
    label: "Confirm before closing a tab via keyboard shortcut",
    description:
      "Ask for confirmation when a keyboard shortcut closes a tab with a live session, or a tab group",
    category: "safety-prompts",
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
    label: "Confirm before closing a tab with a live session",
    description:
      "Ask for confirmation before closing a tab or split panel that holds a live session",
    category: "safety-prompts",
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
    label: "Show a one-time notice when closing a persistent-session tab",
    description:
      "Show a one-time notice that a persistent session keeps running when its tab is closed",
    category: "safety-prompts",
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
    id: "confirmUndoableDelete",
    label: "Confirm before deletes that can be undone",
    description:
      "Ask for confirmation before deleting a connection folder, a custom theme, or an idle tunnel. The Undo toast appears either way",
    category: "safety-prompts",
    keywords: [
      "confirm",
      "delete",
      "remove",
      "undo",
      "folder",
      "theme",
      "tunnel",
      "prompt",
      "dialog",
    ],
  },
  {
    id: "warnLargePortScan",
    label: "Warn before a large port scan",
    description:
      "Show a warning before starting a Port Scanner scan that probes a very large number of host/port combinations",
    category: "safety-prompts",
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
    label: "Warn before a large ping sweep",
    description:
      "Show a warning before starting a Ping Sweep across a very large number of hosts (e.g. a wide CIDR block)",
    category: "safety-prompts",
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
    id: "fileLogLevel",
    label: "Log file verbosity",
    description: "How much detail termiHub writes to its log file; raise it when reporting a bug",
    category: "general",
    keywords: [
      "log",
      "logs",
      "logging",
      "log level",
      "verbosity",
      "debug",
      "trace",
      "diagnostics",
      "troubleshoot",
      "troubleshooting",
      "bug report",
      "termihub.log",
      "file log",
      "support",
    ],
  },
  {
    id: "showCrashReportNotice",
    label: "Crash report notice",
    description:
      "Offer to view or export the local crash report on the next start after a crash; export a diagnostics bundle",
    category: "general",
    keywords: [
      "crash",
      "crash report",
      "diagnostics",
      "export diagnostics",
      "bug report",
      "notice",
      "privacy",
      "telemetry",
      "troubleshoot",
    ],
  },
  {
    id: "experimentalFeaturesEnabled",
    label: EXPERIMENTAL_SETTING_LABEL,
    description:
      "Show experimental features that are not guaranteed to be released or long-term supported",
    category: "general",
    keywords: ["experimental", "beta", "preview", "unstable", "hidden", "features", "labs"],
  },
  {
    id: "frontendPluginsEnabled",
    label: "Enable frontend (JavaScript) plugins",
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
    id: "pluginIndexUrl",
    label: "Plugin index URL",
    description:
      "Browse plugins: the curated plugin index to list (termiHub-maintained by default). Fetched only when you click Load; installs are checksum-verified and always need your confirmation.",
    category: "plugins",
    keywords: [
      "plugin",
      "browse",
      "discover",
      "catalog",
      "store",
      "marketplace",
      "index",
      "install",
      "url",
      "download",
    ],
  },
  {
    id: "pluginUpdateCheckEnabled",
    label: "Check for plugin updates automatically",
    description:
      "Off by default. When on, plugins that publish an update URL are checked once a day. Updates are never installed without your confirmation.",
    category: "plugins",
    keywords: ["plugin", "update", "upgrade", "version", "check", "automatic", "periodic"],
  },
  {
    id: "nativePluginsEnabled",
    label: "Enable native plugins",
    description:
      "Off by default: native plugins run in a separate, sandboxed process. Each must be trusted individually before it loads (PLG-006).",
    category: "plugins",
    keywords: [
      "plugin",
      "native",
      "sandbox",
      "backend",
      "security",
      "trust",
      "acknowledge",
      "untrusted",
      "sandbox",
      "privileges",
    ],
  },
  {
    id: "restoreLastSessionOnStartup",
    label: "Restore last session on startup",
    description:
      "Never, ask, or always reopen the tabs and layout from your previous session when the app starts",
    category: "sessions",
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
    label: "Auto-save sessions to history",
    description: "Record every session opened so it can be reconnected from Recent Sessions",
    category: "sessions",
    keywords: ["session", "history", "recent", "record", "auto-save", "mobaxterm", "quick connect"],
  },
  {
    id: "sessionHistoryLimit",
    label: "Session history limit",
    description: "Maximum number of recent sessions to keep before the oldest is evicted",
    category: "sessions",
    keywords: ["session", "history", "limit", "recent", "max", "count", "evict"],
  },
  {
    id: "showRecentSessions",
    label: "Show recent sessions panel",
    description: "Show the Recent Sessions sidebar panel and its activity-bar icon",
    category: "sessions",
    keywords: ["session", "history", "recent", "sidebar", "panel", "show", "hide"],
  },
  {
    id: "networkToolHistoryEnabled",
    label: "Record network tool history",
    description:
      "Keep a local history of finished network tool runs (ping, traceroute, port scan, DNS, …) and HTTP monitor checks to revisit, re-run and export",
    category: "sessions",
    keywords: [
      "network",
      "tools",
      "history",
      "ping",
      "traceroute",
      "port scan",
      "dns",
      "http monitor",
      "checks",
      "results",
      "record",
      "clear",
      "privacy",
    ],
  },
  {
    id: "provideXServerAutomatically",
    label: "Provide X server automatically",
    description: "Start a local X server automatically for X11 forwarding",
    category: "x-server",
    keywords: ["x server", "x11", "xserver", "display", "vcxsrv", "forwarding", "gui"],
  },
  {
    id: "stopXServerWhenIdle",
    label: "Stop X server when idle",
    description: "Shut down the auto-provided X server when no connection uses it",
    category: "x-server",
    keywords: ["x server", "x11", "idle", "stop", "shutdown", "display"],
  },
  {
    id: "pluginSettings",
    label: "Plugin settings",
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
    id: "backupRestore",
    label: "Backup & restore",
    description:
      "Back up all app data (optionally with encrypted credentials) to one file and restore it",
    category: "backup",
    keywords: [
      "backup",
      "restore",
      "export",
      "import",
      "migrate",
      "new machine",
      "transfer",
      "credentials",
      "vault",
      "plugins",
      "host keys",
      "known hosts",
    ],
  },
  {
    id: "importMobaxterm",
    label: "Import from MobaXterm",
    description:
      "Bring saved MobaXterm sessions and their folders into termiHub (one-time migration)",
    category: "import",
    keywords: [
      "mobaxterm",
      "moba",
      "import",
      "migrate",
      "migration",
      "switch",
      "sessions",
      "bookmarks",
      "mxtsessions",
      "ini",
    ],
  },
  {
    id: "importSshConfig",
    label: "Import from ~/.ssh/config",
    description: "Create saved SSH connections from the hosts in your OpenSSH client config",
    category: "import",
    keywords: ["ssh", "ssh config", "openssh", "hosts", "import", "bulk", "onboard"],
  },
  {
    id: "importInventory",
    label: "Onboard hosts from a CSV / inventory",
    description: "Create many saved connections at once from a CSV or inventory file",
    category: "import",
    keywords: ["csv", "inventory", "fleet", "onboard", "hosts", "bulk", "import", "tsv"],
  },
  {
    id: "importExportConnections",
    label: "Import / export connections",
    description: "Move saved connections and folders between termiHub installs as a JSON file",
    category: "import",
    keywords: ["import", "export", "json", "connections", "share", "transfer", "file"],
  },
  {
    id: "portableMode",
    label: "Portable mode",
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
    label: "Config migration",
    description: "Export or import configuration between installed and portable mode",
    category: "portable",
    keywords: ["export", "import", "migrate", "copy", "transfer", "backup", "portable"],
  },
  {
    id: "schedules",
    label: "Schedules",
    description: "View, pause, resume and delete scheduled workflow and macro runs",
    category: "schedules",
    keywords: [
      "schedule",
      "scheduled",
      "cron",
      "timer",
      "pause",
      "resume",
      "macro",
      "workflow",
      "automation",
    ],
  },
  {
    id: "externalConnectionFiles",
    label: "External connection files",
    description:
      "Load shared connection configs from external JSON files, e.g. from a git repository",
    category: "external-files",
    keywords: [
      "external",
      "connection file",
      "json",
      "shared connections",
      "git",
      "team",
      "import",
      "reload",
    ],
  },
  {
    id: "powerMonitoring",
    label: "Power monitoring",
    description: "Monitor CPU, memory, and power events via SSH agent connections",
    category: "monitoring",
    // "advanced" / "external" keep the pre-#5775 home (External files ▸ Advanced) findable.
    keywords: ["power", "monitoring", "cpu", "memory", "agent", "ssh", "advanced", "external"],
  },
  {
    id: "monitorLocalShells",
    label: "Monitor local shells",
    description: "Show CPU, memory, disk and network for this computer in local shell tabs",
    category: "monitoring",
    keywords: [
      "monitoring",
      "local",
      "shell",
      "cpu",
      "memory",
      "host metrics",
      "advanced",
      "external",
    ],
  },
  {
    id: "statusBarMetrics",
    label: "Status bar metrics",
    description: "The host metrics shown in the status bar: CPU, memory, disk, swap, network",
    category: "monitoring",
    keywords: [
      "status bar",
      "metrics",
      "chips",
      "swap",
      "cpu",
      "memory",
      "disk",
      "network",
      "monitoring",
      "advanced",
      "external",
    ],
  },
  {
    id: "trustedPublishers",
    label: "Trusted publishers",
    description: "Publisher keys termiHub trusts to sign plugins",
    category: "plugins",
    keywords: [
      "trusted publisher",
      "publisher",
      "signing key",
      "signature",
      "verified",
      "plugin",
      "revoke",
    ],
  },
  {
    id: "updateAutoCheck",
    label: "Auto-check for updates",
    description: "Check for app updates on startup and every 24 hours while running",
    category: "updates",
    keywords: ["update", "updates", "auto-check", "auto check", "automatic", "startup", "release"],
  },
  {
    id: "updateStatus",
    label: "Update status",
    description: "Current and latest version, last check time, and Check now",
    category: "updates",
    keywords: ["update", "updates", "version", "check now", "build", "download", "latest"],
  },
];

/** Options for {@link filterSettings} and {@link getMatchingCategories}. */
export interface SettingsFilterOptions {
  /**
   * Whether experimental features are enabled. When false (the default),
   * entries marked `experimental` are never returned (#5365).
   */
  experimental?: boolean;
}

/**
 * Filter settings by a search query. Matches against label, description,
 * category, and keywords (case-insensitive). Experimental-only entries are
 * excluded unless `options.experimental` is true.
 */
export function filterSettings(
  query: string,
  { experimental = false }: SettingsFilterOptions = {}
): SettingDefinition[] {
  const q = query.toLowerCase().trim();
  const available = experimental
    ? SETTINGS_REGISTRY
    : SETTINGS_REGISTRY.filter((setting) => !setting.experimental);
  if (!q) return available;

  return available.filter((setting) => {
    const haystack = [setting.label, setting.description, setting.category, ...setting.keywords]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Return the set of categories that contain at least one matching setting.
 */
export function getMatchingCategories(
  query: string,
  options: SettingsFilterOptions = {}
): Set<SettingsCategory> {
  const matched = filterSettings(query, options);
  return new Set(matched.map((s) => s.category));
}
