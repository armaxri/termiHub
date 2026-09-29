import { RemoteAgentConfig } from "./terminal";
// DTOs generated from their Rust source of truth via ts-rs (audit DUP-030 /
// MOCK-005). Imported here so this module can both re-export them (below) and
// reference them locally (e.g. the tree-node union, DEFAULT_AGENT_SETTINGS).
import type { ConnectionFolder } from "./generated/ConnectionFolder";
import type { AgentSettings } from "./generated/AgentSettings";
import type { SavedConnection } from "./generated/SavedConnection";
import type { JumpHostConfig } from "./generated/JumpHostConfig";
import type { ExternalFileConfig } from "./generated/ExternalFileConfig";
import type { ConnectionTypeInfo } from "./generated/ConnectionTypeInfo";
import type { LayoutConfig } from "./generated/LayoutConfig";
import type { SerialPortScanPrefix } from "./generated/SerialPortScanPrefix";
import type { CustomLanguageGrammar } from "./generated/CustomLanguageGrammar";
import type { UpdateSettings } from "./generated/UpdateSettings";
import type { AppSettings } from "./generated/AppSettings";
import type { AgentCapabilities } from "./generated/AgentCapabilities";
import type { SavedContainerRuntime, SpawnKind } from "./spawn";

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

// In-memory representation of a saved connection (with a generated path-based
// ID). Generated from the Rust `SavedConnection`
// (src-tauri/src/connection/config.rs) via ts-rs (audit DUP-030 / FEC-008); the
// CI staleness gate replaces the former hand-rolled Rust drift guard.
export type { SavedConnection };

// In-memory representation of a folder (with a generated path-based ID).
// Generated from the Rust `ConnectionFolder` (src-tauri/src/connection/config.rs)
// via ts-rs (audit DUP-030).
export type { ConnectionFolder };

/**
 * A single jump host (bastion) hop in an SSH `ProxyJump` chain.
 *
 * Generated from the Rust `JumpHostConfig` (`core/src/config/mod.rs`) via ts-rs
 * (audit DUP-030). Stored inline on an SSH connection's `proxyJump` array. A hop
 * either carries the inline connection fields or references a saved SSH
 * connection by `connectionId`, which the backend expands to inline fields at
 * connect time (#940). `port` is `number | ""` because the jump-host editor
 * shares this shape and uses `""` for a cleared field (#1444).
 */
export type { JumpHostConfig };

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
 * Generated from the Rust `ImportableHost` (`commands/ssh_config_import.rs`)
 * via ts-rs (audit DUP-030).
 */
export type { SshConfigImportHost } from "./generated/SshConfigImportHost";

/**
 * A whole SSH connection resolved from a `~/.ssh/config` `Host` stanza (#1722),
 * offered to the connection editor to pre-populate a new SSH connection.
 * Generated from the Rust `ImportableConnection`
 * (`commands/ssh_config_import.rs`) via ts-rs (audit DUP-030).
 */
export type { SshConfigImportConnection } from "./generated/SshConfigImportConnection";

/**
 * One host parsed from a CSV / simple inventory file (#1961), offered to the
 * fleet-onboard flow to stamp onto a chosen connection template. `port` /
 * `username` are optional per-host overrides — absent means "inherit the
 * template's value". The same shape also carries scan-result hosts into the
 * flow. Generated from the Rust `InventoryHost` (`commands/inventory_import.rs`)
 * via ts-rs (audit DUP-030).
 */
export type { InventoryHost } from "./generated/InventoryHost";

// DUP-008: the connection tree's source of truth is the Rust on-disk
// `ConnectionTreeNode` (`src-tauri/src/connection/config.rs`). It never crosses
// IPC: storage flattens it into the generated `ConnectionFolder` /
// `SavedConnection` above, which are what the frontend consumes. The former
// hand-written `ConnectionTreeItem` mirror had no consumers and was removed.

// Generated from the Rust `ExternalFileConfig` (src-tauri/src/connection/settings.rs)
// via ts-rs (audit DUP-030). Imported at the top of this module; re-exported here.
export type { ExternalFileConfig };

/** Error encountered when loading an external connection file (generated via ts-rs). */
export type { ExternalFileError } from "./generated/ExternalFileError";

/** A warning generated during file recovery at startup (generated via ts-rs). */
export type { RecoveryWarning } from "./generated/RecoveryWarning";

/**
 * Info about a connection type from the backend registry. Generated from core's
 * `ConnectionTypeInfo` (`core/src/connection/registry.rs`) via ts-rs (#3088).
 */
export type { ConnectionTypeInfo };

// Runtime behaviour preferences for a connected remote agent.
// Generated from the Rust `AgentSettings` (src-tauri/src/connection/config.rs)
// via ts-rs (audit DUP-030 / MOCK-005). The default *value* below stays
// hand-written — ts-rs generates types, not values.
export type { AgentSettings };

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

// Capabilities reported by a connected remote agent — generated from the Rust
// `AgentCapabilities` (`src-tauri/src/terminal/agent_manager/types.rs`) via
// ts-rs (audit DUP-030, #3802).
export type { AgentCapabilities };

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

/**
 * A saved connection's id changed from `oldId` to `newId` — a rename or move of
 * the connection or of a folder above it (#3569). Payload item of the backend
 * `connection-ids-changed` event (#3579). Generated from the Rust
 * `ConnectionIdChange` (`src-tauri/src/connection/id_changes.rs`) via ts-rs.
 */
export type { ConnectionIdChange } from "./generated/ConnectionIdChange";

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

// The persisted layout is generated from the Rust `LayoutConfig`
// (`src-tauri/src/connection/settings.rs`) via ts-rs (audit DUP-030, #3088).
export type { LayoutConfig };

// Settings sub-DTOs generated from `src-tauri/src/connection/settings.rs` via
// ts-rs (audit DUP-030, #3088).
export type { SerialPortScanPrefix, CustomLanguageGrammar, UpdateSettings };

/** Where the activity bar sits. */
export type ActivityBarPosition = LayoutConfig["activityBarPosition"];
/** Which side the sidebar sits on. */
export type SidebarPosition = LayoutConfig["sidebarPosition"];

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

// Generated from the Rust `AppSettings` (`src-tauri/src/connection/settings.rs`)
// via ts-rs (audit DUP-030, #3802). Frontend-owned shapes the backend stores
// opaquely (`customThemes`, `syntaxHighlighting`, `shellIntegration`) are typed
// through ts-rs overrides that point back at their frontend definitions.
export type { AppSettings };

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
