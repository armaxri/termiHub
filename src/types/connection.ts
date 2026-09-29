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

// Shell context-menu / CLI-spawn integration settings and status (epic #1363),
// generated from `src-tauri/src/connection/shell_integration.rs` via ts-rs
// (audit DUP-030, #3088).
export type { ShellEntryVisibility } from "./generated/ShellEntryVisibility";
export type { ShellIntegrationFallback } from "./generated/ShellIntegrationFallback";
export type { ShowForTargets } from "./generated/ShowForTargets";
export type { ShellEntry } from "./generated/ShellEntry";
export type { LinuxFileManagerToggles } from "./generated/LinuxFileManagerToggles";
export type { ShellIntegrationSettings } from "./generated/ShellIntegrationSettings";
export type { DetectedFileManager } from "./generated/DetectedFileManager";
export type { ShellIntegrationStatus } from "./generated/ShellIntegrationStatus";

// Generated from the Rust `AppSettings` (`src-tauri/src/connection/settings.rs`)
// via ts-rs (audit DUP-030, #3802). Frontend-owned shapes the backend stores
// opaquely (`customThemes`, `syntaxHighlighting`, `shellIntegration`) are typed
// through ts-rs overrides that point back at their frontend definitions.
export type { AppSettings };

/** Result of an update check (generated from `commands/update.rs` via ts-rs). */
export type { UpdateInfo } from "./generated/UpdateInfo";

/** Current app mode (generated from `commands/portable.rs` via ts-rs). */
export type { AppModeInfo } from "./generated/AppModeInfo";

/** Status of a single config file in a directory (generated via ts-rs). */
export type { ConfigFileStatus } from "./generated/ConfigFileStatus";

/** Result of a config export or import operation (generated via ts-rs). */
export type { ConfigMigrationResult } from "./generated/ConfigMigrationResult";

/**
 * A file browser directory entry, generated from the core `FileEntry`
 * (`core/src/files/mod.rs`) via ts-rs. `writable` is a cheap, conservative hint
 * (`null` when unknown); the authoritative per-file answer comes from the
 * `sftp_check_writable` command. `isSymlink`/`symlinkTarget` are optional so
 * payloads persisted before those fields existed still decode.
 */
export type { FileEntry } from "./generated/FileEntry";

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
