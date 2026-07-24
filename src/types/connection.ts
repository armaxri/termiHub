import { ConnectionConfig, RemoteAgentConfig, TerminalOptions, LineEnding } from "./terminal";
import { SettingsSchema, Capabilities } from "./schema";
import { KeybindingOverrideEntry } from "./keybindings";
import type { SavedContainerRuntime, SpawnKind } from "./spawn";
import type { SyntaxHighlightingConfig } from "./syntaxHighlighting";
import type { ThemeDefinition } from "@/themes/types";

/**
 * Explicit lifecycle status of the single desktop SFTP session (audit gap A1).
 *
 * Replaces the previously-overloaded `sftpLoading` boolean, which could not
 * distinguish "connecting" from "listing"/"refreshing" from "idle". The UI reads
 * this to pick the right placeholder (e.g. "Connecting SFTP…" vs "Loading…").
 *
 * - `idle`      — no session, no error (initial / after disconnect)
 * - `connecting`— `connectSftp` in flight, no session yet
 * - `connected` — session established, no operation in flight
 * - `listing`   — a `navigateSftp` / `refreshSftp` list request is in flight
 * - `error`     — the last connect or list operation failed (see `sftpError`)
 */
export type SftpStatus = "idle" | "connecting" | "connected" | "listing" | "error";

/**
 * A live backend SFTP session tracked in the keyed session map (issue #1241).
 *
 * Sessions are keyed by their session-id / UUID; this record holds only the
 * display metadata and the binding needed for lifecycle cleanup.
 *
 * - `hostLabel`   — `user@host:port`, shown in the Open Connections panel
 * - `owningTabId` — the tab that opened the session; when that tab closes the
 *   session is closed (`sftp_close`) and removed (the L1 leak fix)
 */
export interface SftpSessionEntry {
  hostLabel: string;
  owningTabId: string;
}

/**
 * Live state of a single in-flight SFTP transfer, keyed by its `transferId` in
 * the store's `transfers` map (concept "SFTP session tracking + transfers",
 * issue #1247). Built purely from `transfer-progress` events (#1245): a
 * `transferring` phase upserts the row; a terminal phase
 * (`done`/`cancelled`/`error`) clears it.
 *
 * - `sessionId`   — the owning SFTP session, used by the kill-cascade to cancel
 *   a session's transfers before closing it
 * - `total = 0`   — indeterminate size (render a spinner instead of a bar)
 */
export interface TransferState {
  transferId: string;
  sessionId: string;
  direction: "download" | "upload";
  fileName: string;
  transferred: number;
  total: number;
  phase: "transferring" | "done" | "cancelled" | "error";
  // Queue-model additive fields (#1336), populated for FTP transfers and
  // derived for SFTP. Optional so existing SFTP consumers are unaffected.
  state?: "queued" | "active" | "paused" | "completed" | "failed" | "cancelled";
  speed?: number;
  totalBytes?: number;
  etaSecs?: number;
  attempt?: number;
  maxAttempts?: number;
}

export interface SavedConnection {
  id: string;
  name: string;
  config: ConnectionConfig;
  folderId: string | null;
  terminalOptions?: TerminalOptions;
  icon?: string;
  /** Which external file this connection was loaded from. null = main connections.json. */
  sourceFile?: string | null;
}

export interface ConnectionFolder {
  id: string;
  name: string;
  parentId: string | null;
  isExpanded: boolean;
}

/**
 * A single jump host (bastion) hop in an SSH `ProxyJump` chain.
 *
 * Mirrors the Rust `JumpHostConfig` (`core/src/config/mod.rs`). Stored inline on
 * an SSH connection's `proxyJump` array. `connectionId` (a reference to a saved
 * SSH connection) is reserved for a later phase; current editing uses the inline
 * connection fields.
 */
export interface JumpHostConfig {
  /** Reference to a saved SSH connection (reserved; resolved by a later phase). */
  connectionId?: string;
  host: string;
  /**
   * SSH port. While editing, a cleared field is `""` (the shared `number | ""`
   * blank-value convention, #1444) which `validateProxyJump` flags as required
   * rather than coercing to a default; a persisted hop always holds a number.
   */
  port: number | "";
  username: string;
  /** "key" | "password" | "agent". */
  authMethod: string;
  password?: string;
  keyPath?: string;
  /**
   * Per-hop connect/handshake timeout (seconds). Unset falls back to the default
   * SSH connect timeout, mirroring the target's `connectTimeoutSecs` (#951).
   */
  connectTimeoutSecs?: number;
}

/**
 * SSH-connection settings the connection editor manages directly (as opposed to
 * the schema-driven fields rendered by `ConnectionSettingsForm`). They live as
 * sibling keys on the connection's unstructured `settings` record and mirror the
 * Rust `SshConfig` (`core/src/config/mod.rs`).
 */
export interface SshEditorSettings {
  /**
   * Forward the local `ssh-agent` to the target (OpenSSH `ForwardAgent`, #1699),
   * so the agent's keys are usable on the final host — and, because the
   * forwarded-agent channel rides the jump-host tunnel, through the whole
   * `proxyJump` chain. Mirrors `SshConfig.forward_agent`; omitted/`false` by
   * default, keeping existing saved connections unchanged.
   */
  forwardAgent?: boolean;
  /** Jump-host (`ProxyJump`) chain; empty/omitted means a direct connection. */
  proxyJump?: JumpHostConfig[];
}

/**
 * A host from the user's `~/.ssh/config` that declares a `ProxyJump`, offered
 * for one-shot import into the first-class jump-host editor (#1702).
 *
 * `name` is the OpenSSH `Host` alias; `proxyJump` is the resolved hop chain
 * (outermost → innermost), reusing the same {@link JumpHostConfig} shape the
 * editor stores so it drops straight into a connection's `proxyJump` array.
 */
export interface SshConfigImportHost {
  name: string;
  proxyJump: JumpHostConfig[];
}

/**
 * A whole SSH connection resolved from a `~/.ssh/config` `Host` stanza (#1722),
 * offered to the connection editor to pre-populate a new SSH connection.
 *
 * Unlike {@link SshConfigImportHost} (jump-host chain only), this is the target
 * connection itself: `name` is the OpenSSH `Host` alias, `host`/`port`/`username`
 * are the resolved `Hostname`/`Port`/`User`, and `authMethod`/`keyPath` mirror
 * the jump-host import's mapping (`IdentityFile` → `"key"`, else `"agent"`).
 * `proxyJump` is the target's own resolved hop chain, empty for a direct host.
 */
export interface SshConfigImportConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  keyPath?: string;
  proxyJump: JumpHostConfig[];
}

export type ConnectionTreeItem =
  | { type: "folder"; folder: ConnectionFolder }
  | { type: "connection"; connection: SavedConnection };

export interface ExternalFileConfig {
  path: string;
  enabled: boolean;
}

/** Error encountered when loading an external connection file. */
export interface ExternalFileError {
  filePath: string;
  error: string;
}

/** A warning generated during file recovery at startup. */
export interface RecoveryWarning {
  fileName: string;
  message: string;
  details: string | null;
}

/** Info about a connection type from the backend registry. */
export interface ConnectionTypeInfo {
  typeId: string;
  displayName: string;
  icon: string;
  schema: SettingsSchema;
  capabilities: Capabilities;
}

/** Runtime behaviour preferences for a connected remote agent. */
export interface AgentSettings {
  enableMonitoring: boolean;
  enableFileBrowser: boolean;
  enableDocker: boolean;
  defaultShell: string | null;
  startingDirectory: string;
  logLevel: "error" | "warn" | "info" | "debug" | "trace";
  verboseTracing: boolean;
  /** Ring-buffer size for persistent sessions in MiB (1–64). */
  persistentScrollbackBufferSizeMb: number;
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enableMonitoring: true,
  enableFileBrowser: true,
  enableDocker: true,
  defaultShell: null,
  startingDirectory: "~",
  logLevel: "info",
  verboseTracing: false,
  persistentScrollbackBufferSizeMb: 1,
};

/** Capabilities reported by a connected remote agent. */
export interface AgentCapabilities {
  connectionTypes: ConnectionTypeInfo[];
  maxSessions: number;
  availableShells?: string[];
  availableSerialPorts?: string[];
  dockerAvailable?: boolean;
  availableDockerImages?: string[];
  /** Whether `/proc`-based (or platform-equivalent) monitoring is available. */
  monitoringSupported?: boolean;
  /** Agent binary version string, e.g. "1.4.2". */
  agentVersion?: string;
}

/** A remote agent definition stored in the sidebar as a folder-like entry. */
export interface RemoteAgentDefinition {
  id: string;
  name: string;
  config: RemoteAgentConfig;
  agentSettings: AgentSettings;
  isExpanded: boolean;
  connectionState: "disconnected" | "connecting" | "connected" | "reconnecting";
  capabilities?: AgentCapabilities;
  /**
   * The last error reported when the agent transitioned to `disconnected` after
   * auto-reconnect exhausted its retries (G3, #1236). Surfaced as the tooltip on
   * the disconnected header's Reconnect button. Cleared on the next connect
   * attempt (`connecting`) or a successful `connected` transition.
   */
  lastError?: string;
}

// ── Persistent connection session state ──────────────────────────────────

/** Live run-state of a persistent connection's background process. */
export type PersistentRunState =
  | "stopped"
  | "starting"
  | "running"
  | "attached"
  | "stopping"
  | "error";

/** Frontend state entry for one persistent connection. */
export interface PersistentSessionEntry {
  connectionId: string;
  sessionId: string | null;
  state: PersistentRunState;
  /** IDs of tabs currently attached to this session. */
  attachedTabIds: string[];
  errorMessage?: string;
}

// ── Layout / activity bar ─────────────────────────────────────────────────

export type ActivityBarPosition = "left" | "right" | "top" | "hidden";
export type SidebarPosition = "left" | "right";

export interface LayoutConfig {
  activityBarPosition: ActivityBarPosition;
  sidebarPosition: SidebarPosition;
  sidebarVisible: boolean;
  statusBarVisible: boolean;
  hiddenActivityBarViews: string[];
  /** The currently active sidebar panel. Persisted across restarts. */
  sidebarView?: string;
  /** Whether the sidebar is currently collapsed. Persisted across restarts. */
  sidebarCollapsed?: boolean;
}

export const DEFAULT_LAYOUT: LayoutConfig = {
  activityBarPosition: "left",
  sidebarPosition: "left",
  sidebarVisible: true,
  statusBarVisible: true,
  hiddenActivityBarViews: [],
};

export const LAYOUT_PRESETS: Record<string, LayoutConfig> = {
  default: {
    activityBarPosition: "left",
    sidebarPosition: "left",
    sidebarVisible: true,
    statusBarVisible: true,
    hiddenActivityBarViews: [],
  },
  focus: {
    activityBarPosition: "left",
    sidebarPosition: "left",
    sidebarVisible: false,
    statusBarVisible: true,
    hiddenActivityBarViews: [],
  },
  zen: {
    activityBarPosition: "hidden",
    sidebarPosition: "left",
    sidebarVisible: false,
    statusBarVisible: false,
    hiddenActivityBarViews: [],
  },
};

/** A Linux `/dev` prefix entry for the serial port scanner. */
export interface SerialPortScanPrefix {
  prefix: string;
  enabled: boolean;
  /** `true` = shipped with termiHub; `false` = user-added. */
  builtIn: boolean;
}

/** Windows context-menu visibility for a shell-integration entry. */
export type ShellEntryVisibility = "always" | "extended";

/** Fallback behaviour when no shell-integration entry resolves a spawn request. */
export type ShellIntegrationFallback = "picker" | "systemDefaultShell";

/** Which right-click targets a shell-integration entry is offered for. */
export interface ShowForTargets {
  /** Right-click on a folder. */
  folders: boolean;
  /** Right-click on a file (opens a terminal in the parent directory). */
  files: boolean;
  /** Right-click on the folder background (empty space). */
  folderBackground: boolean;
}

/** A single configurable "Open in termiHub" quick-access entry. */
export interface ShellEntry {
  /** Stable identifier embedded in the registered command (`--entry-id`). */
  id: string;
  /** Display name shown in the file-manager context menu. */
  name: string;
  /** Saved connection this entry opens. Omitted → the entry shows the session picker. */
  connectionId?: string;
  /** Windows context-menu visibility (Always / Extended-only). */
  visibility: ShellEntryVisibility;
  /** Which right-click targets this entry is registered for. */
  showFor: ShowForTargets;
  /**
   * Saved per-entry container-image preference (e.g. `"alpine:3"`). Used when
   * this entry opens a "new container" spawn and no explicit `--container-image`
   * is given, ahead of the built-in default. Omitted → no saved preference.
   */
  containerImage?: string;
  /**
   * Saved per-entry in-container mount-target preference (e.g. `"/src"`). Same
   * priority as {@link containerImage}: honored for a container spawn when no
   * explicit `--container-mount` is given.
   */
  containerMount?: string;
  /**
   * The kind of session this entry opens — written by the Session Picker's
   * "Remember this choice" (#1561). `"auto"` (the default) means no remembered
   * choice, keeping the presence-based inference. Anything else is emitted as
   * `--kind <token>` at registration time and pins how a context-menu click
   * resolves.
   */
  spawnKind?: SpawnKind;
  /**
   * Saved per-entry shell preference in the backend's single-string encoding: a
   * local shell name (`"zsh"`) or a WSL distribution as `"wsl:<distro>"`.
   * Honored for a local/WSL spawn when no explicit shell is passed.
   */
  shell?: string;
  /**
   * Saved per-entry container-runtime preference — the Docker/Podman section the
   * user picked. `"auto"` (the default) keeps detecting whichever runtime is
   * installed.
   */
  containerRuntime?: SavedContainerRuntime;
}

/** Linux per-file-manager install toggles (Linux-only in effect). */
export interface LinuxFileManagerToggles {
  /** Install Nautilus (GNOME) scripts. */
  nautilus: boolean;
  /** Install the KDE (Dolphin) service menu. */
  kde: boolean;
  /** Install the Thunar (XFCE) custom action. */
  thunar: boolean;
}

/** Persisted shell context-menu / CLI-spawn integration settings (epic #1363). */
export interface ShellIntegrationSettings {
  /** Configured quick-access entries, in display / priority order. */
  entries: ShellEntry[];
  /** What to do when no entry resolves a request. */
  fallback: ShellIntegrationFallback;
  /** Open spawned sessions in a new window instead of the running instance. */
  openInNewWindow: boolean;
  /** Whether the OS context-menu integration is currently registered. */
  registered: boolean;
  /** Absolute executable path recorded at registration time (staleness check). */
  registeredExePath?: string;
  /** Linux per-file-manager install toggles. */
  linuxFileManagers: LinuxFileManagerToggles;
  /** Whether the user dismissed the first-launch install banner. */
  firstLaunchBannerDismissed: boolean;
}

/** A file manager detected on the host, reported by the status command. */
export interface DetectedFileManager {
  /** Stable id (`"nautilus"`, `"kde"`, `"thunar"`, …). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Whether the manager was found on this host. */
  detected: boolean;
  /** Detected version string, when known. */
  version?: string;
}

/** Registration + staleness status reported to the shell-integration settings UI. */
export interface ShellIntegrationStatus {
  /** Whether the OS context-menu integration is currently registered. */
  registered: boolean;
  /** Executable path recorded at registration time, if any. */
  registeredExePath?: string;
  /** The current executable path, if resolvable. */
  currentExePath?: string;
  /** Whether the registered path matches the current executable. */
  exePathMatches: boolean;
  /** True when registered but the executable moved — re-registration needed. */
  stale: boolean;
  /** Whether the app runs in portable mode (where staleness is expected). */
  portable: boolean;
  /**
   * File managers detected on the host. On Linux this lists Nautilus, Dolphin
   * (KDE) and Thunar with their versions where available; on macOS/Windows the
   * native manager (Finder / File Explorer).
   */
  detectedFileManagers: DetectedFileManager[];
}

export interface AppSettings {
  version: string;
  externalConnectionFiles: ExternalFileConfig[];
  defaultUser?: string;
  defaultSshKeyPath?: string;
  defaultShell?: string;
  /**
   * Active color theme. Built-in values plus `custom:<id>`, which selects a
   * user-defined theme from {@link AppSettings.customThemes} by its `id`.
   * Defaults to `"dark"` when absent (backward compatible).
   */
  theme?: "dark" | "light" | "solarized-dark" | "solarized-light" | "system" | `custom:${string}`;
  /**
   * User-defined custom color themes. Each entry is a full, self-contained
   * {@link ThemeDefinition} (all colors resolved) with an optional `baseTheme`
   * recording the built-in theme it was derived from. Serializable as-is so
   * import/export (#1880) can build on this shape. Absent → no custom themes.
   */
  customThemes?: ThemeDefinition[];
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  defaultHorizontalScrolling?: boolean;
  scrollbackBuffer?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  powerMonitoringEnabled: boolean;
  fileBrowserEnabled: boolean;
  /**
   * Show a confirmation dialog when the user closes a tab via the
   * close-tab or close-tab-group keyboard shortcut. Defaults to true.
   */
  confirmCloseTabOnShortcut?: boolean;
  /**
   * Show a confirmation dialog before closing a tab or split panel that holds a
   * live session (SSH/serial/local shell/telnet) via the tab X, middle-click, or
   * the panel close button. Defaults to true. The dialog's "Don't ask again"
   * opt-out flips this off; it can be re-enabled from General settings.
   */
  confirmCloseLiveSession?: boolean;
  /**
   * When true (default), saving terminal content to a file shows a dialog
   * offering to open the saved file in a Monaco editor tab. When false, the
   * file is saved silently and no dialog or editor tab is opened.
   */
  askOpenSavedFileInTab?: boolean;
  /**
   * Show a warning before starting a Port Scanner scan whose estimated probe
   * count is very large (many host/port combinations). Defaults to true. The
   * warning dialog's "Don't warn again" opt-out flips this off; it can be
   * re-enabled from General settings.
   */
  warnLargePortScan?: boolean;
  defaultShellIntegration?: boolean;
  defaultX11Forwarding?: boolean;
  /** Start/provide a local X server automatically for SSH X11 forwarding. Unset → platform default (on for Windows). */
  provideXServerAutomatically?: boolean;
  /** Stop the auto-provided X server once no connection is using it. */
  stopXServerWhenIdle?: boolean;
  /**
   * When true (default), the open tab groups and layout are auto-saved on every
   * change and restored on the next startup. When false, the app always starts
   * with a fresh empty session.
   */
  restoreLastSessionOnStartup?: boolean;
  layout?: LayoutConfig;
  credentialStorageMode?: "master_password" | "os_keychain" | "none";
  credentialAutoLockMinutes?: number;
  rightClickBehavior?: "contextMenu" | "quickAction";
  /**
   * Default line ending sent on Enter and used to normalize pasted text for
   * new terminals. Per-connection `terminalOptions.lineEnding` overrides this.
   * Defaults to `lf` when unset.
   */
  defaultLineEnding?: LineEnding;
  keybindingOverrides?: KeybindingOverrideEntry[];
  /**
   * When true (default), application shortcuts that collide with standard
   * shell, tmux, vim, or SSH-to-remote keys are suppressed while the terminal
   * pane is focused so the keystroke reaches the PTY. Toggle off to make
   * every shortcut fire regardless of focus.
   */
  terminalKeyPassthrough?: boolean;
  /**
   * When true (default), an active editor or input-bearing tab handles its own
   * editing shortcuts (Find, Replace, Select All, …) — the global keyboard
   * dispatcher steps aside so the focused widget receives the key. Toggle off to
   * restore the old global-first behavior where app shortcuts fire regardless of
   * the active tab's content.
   */
  editorShortcutDelegation?: boolean;
  /**
   * User-defined file-type overrides for the built-in language mapping.
   * Keys are exact filenames (e.g. `"Jenkinsfile"`) or extensions (e.g. `".conf"`).
   * Values are Monaco language IDs (e.g. `"groovy"`, `"ini"`).
   * These take precedence over the built-in defaults.
   */
  fileLanguageMappings?: Record<string, string>;
  /**
   * Additional Shiki language package IDs to load for syntax highlighting.
   * Values are Shiki bundled language IDs (e.g. `"astro"`, `"svelte"`, `"zig"`).
   * The built-in packages (cmake, toml, nginx, nix) are always loaded regardless.
   */
  installedLanguagePackages?: string[];
  /**
   * User-imported custom TextMate grammar definitions for languages not in Shiki's
   * bundled set. Each entry stores the full grammar JSON so it works without the
   * original file being present.
   */
  customLanguageGrammars?: CustomLanguageGrammar[];
  experimentalFeaturesEnabled?: boolean;
  updates?: UpdateSettings;
  /** Linux `/dev` prefixes used when scanning for serial ports. Always present after `get_settings` (expanded from built-in defaults if never saved). */
  serialPortScanPrefixes?: SerialPortScanPrefix[];
  /** Shell context-menu / CLI-spawn integration configuration (epic #1363). */
  shellIntegration?: ShellIntegrationSettings;
  /**
   * Terminal output syntax-highlighting configuration (epic #1696). Absent
   * config resolves to the built-in defaults (see
   * `services/syntaxHighlightingConfig.ts` → `defaultHighlightingConfig`),
   * which keeps older settings files forward-compatible.
   */
  syntaxHighlighting?: SyntaxHighlightingConfig;
  /**
   * Master opt-in for the guarded `run-local-process` workflow step (#1857).
   * Defaults to `false` (off): a workflow that contains a `run-local-process`
   * step cannot spawn a local program on the user's machine until this is
   * explicitly enabled. This is the primary security guardrail — imported
   * workflows carry such steps but are **never** auto-authorized, so an
   * imported step stays inert until the user turns this on **and** authorizes
   * the specific program (see {@link workflowLocalProcessAllowlist}). Enforced
   * again in the backend spawn command as defence-in-depth.
   */
  workflowLocalProcessEnabled?: boolean;
  /**
   * Programs the user has chosen to always allow a `run-local-process` step to
   * spawn without re-confirming (#1857). A program not on this list triggers a
   * per-run confirmation dialog; "Always allow" appends it here. Independent of
   * workflow data, so importing a workflow can never add an entry — an imported
   * step is unauthorized until the user confirms it interactively.
   */
  workflowLocalProcessAllowlist?: string[];
}

/**
 * A user-imported TextMate grammar definition.
 * The `grammar` field is the parsed `.tmLanguage.json` content stored verbatim.
 */
export interface CustomLanguageGrammar {
  /** Monaco / Shiki language ID used in file-type mappings (e.g. `"my-lang"`). */
  id: string;
  /** Human-readable display name shown in the language picker. */
  name: string;
  /** The raw TextMate grammar object (contents of the `.tmLanguage.json` file). */
  grammar: Record<string, unknown>;
}

/** Persisted update-checker configuration returned from the backend. */
export interface UpdateSettings {
  autoCheck: boolean;
  lastCheckTime?: string;
  skippedVersion?: string;
}

/** Result of an update check returned from the backend. */
export interface UpdateInfo {
  available: boolean;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  isSecurity: boolean;
}

/** Current app mode returned by the backend. */
export interface AppModeInfo {
  isPortable: boolean;
  /** Absolute path to the portable data directory, or null in installed mode. */
  dataDir: string | null;
}

/** Status of a single config file in a directory. */
export interface ConfigFileStatus {
  name: string;
  present: boolean;
}

/** Result of a config export or import operation. */
export interface ConfigMigrationResult {
  filesCopied: string[];
  warnings: string[];
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  permissions: string | null;
  /**
   * Cheap, conservative writability hint derived from `permissions`:
   * `false` only when no class may write, `true` when at least one may,
   * `null` when unknown (permissions absent or the backend does not derive it,
   * e.g. local/docker/agent browsers). The authoritative per-file answer comes
   * from the `sftp_check_writable` command.
   */
  writable: boolean | null;
  /**
   * True when this entry is a symbolic link. Populated by backends that can tell
   * cheaply (the FTP listing parser and the local/SFTP browsers); `false`
   * otherwise. Optional so payloads persisted before the field existed decode.
   */
  isSymlink?: boolean;
  /**
   * The link target when the backend could determine it cheaply (e.g. the
   * `-> target` suffix of a Unix `ls -l` FTP line). `null`/absent for non-links
   * and for formats that do not carry a target (MLSD `type=link`, SFTP readdir).
   */
  symlinkTarget?: string | null;
}

/**
 * Authoritative writability of a specific remote file, decided by a
 * non-destructive SFTP write-open probe (`sftp_check_writable`, #1324).
 *
 * - `"writable"` — the file could be opened for writing.
 * - `"readOnly"` — the server denied the write-open with `PERMISSION_DENIED`.
 * - `"unknown"` — the probe was inconclusive; callers treat it as writable and
 *   attempt the save so a false negative never blocks editing.
 */
export type Writability = "writable" | "readOnly" | "unknown";
