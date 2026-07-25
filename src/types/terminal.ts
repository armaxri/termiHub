import type { ConnectionHighlightingConfig } from "./syntaxHighlighting";

export type SessionId = string;

export type ShellType =
  | "zsh"
  | "bash"
  | "cmd"
  | "powershell"
  | "gitbash"
  | "fish"
  | "nushell"
  | "custom"
  | `wsl:${string}`;

export type ConnectionType =
  | "local"
  | "ssh"
  | "telnet"
  | "serial"
  | "remote"
  | "remote-session"
  | "docker"
  | (string & {});

export type TabContentType =
  | "terminal"
  | "agent-error"
  | "settings"
  | "editor"
  | "connection-editor"
  | "log-viewer"
  | "tunnel-editor"
  | "workspace-editor"
  | "network-diagnostic"
  /**
   * A terminal-less connection (e.g. FTP, `Capabilities.terminal === false`).
   * The tab owns a live session so the sidebar file browser can route to it,
   * but renders a non-terminal placeholder body instead of an xterm terminal
   * (#1335).
   */
  | "file-browser"
  /**
   * A graphical remote-desktop connection (`Capabilities.graphical === true`,
   * e.g. VNC/RDP). Renders a protocol-agnostic `<canvas>` surface with a hover
   * toolbar and connection overlays, driven by the `remote-desktop-*` events.
   * The tab owns its own graphical session (via `remote_desktop_connect`),
   * separate from the terminal SessionManager (#1680).
   */
  | "remote-desktop";

/**
 * Reference to a session-layer file browser backing a remote editor tab (#1557).
 *
 * The session layer ({@link https://github.com/armaxri/termiHub/issues/1335})
 * dispatches file reads/writes through `SessionManager` by session id, so any
 * connection type whose backend implements the `FileBrowser` trait (FTP, Docker,
 * agent sessions, ...) can back an editor tab. `connectionType` is carried for
 * display/diagnostics; routing only needs `sessionId`.
 */
export interface EditorSessionRef {
  sessionId: SessionId;
  connectionType: ConnectionType;
}

/**
 * Describes what an editor tab is editing.
 *
 * `isRemote` means "not on the local disk". Which remote transport backs the
 * tab is then decided by exactly one of two mutually exclusive fields:
 *
 * - {@link sftpSessionId} — the legacy `SftpManager`/`sftp_*` path, used by SSH.
 *   It is the only path that offers the SFTP-specific affordances (writability
 *   probes, exec capability, elevated/sudo writes, realpath, download).
 * - {@link sessionBrowser} — the protocol-agnostic session layer, used by every
 *   other file-browser-capable type (#1557). It offers read and write only; the
 *   SFTP-specific affordances above are gated on `sftpSessionId` and therefore
 *   stay off for these tabs.
 *
 * A local tab (`isRemote: false`) carries neither.
 */
export interface EditorTabMeta {
  filePath: string;
  isRemote: boolean;
  sftpSessionId?: string;
  /**
   * Set when this remote editor tab is backed by the session layer rather than
   * an `SftpManager` session. Mutually exclusive with {@link sftpSessionId}. (#1557)
   */
  sessionBrowser?: EditorSessionRef;
  /**
   * Stable identity of the remote session backing this tab, used to deduplicate
   * editor tabs (#1599). The raw session id is the wrong key on its own: it
   * changes on reconnect, so keying on it would open a duplicate tab instead of
   * refreshing the existing one. This holds a value that is *stable across a
   * reconnect of the same logical connection* but *distinct between different
   * connections*:
   *
   * - SFTP tabs → the session's `hostLabel` (`user@host:port`); a reconnect to
   *   the same host reuses the label.
   * - Session-layer tabs → the id of the terminal tab that owns the backing
   *   session; a reconnect swaps the session id but keeps the tab.
   *
   * Undefined for local tabs (deduped on path alone) and for remote tabs whose
   * identity could not be resolved, in which case dedup falls back to
   * path + `isRemote` only (the pre-#1599 behaviour).
   */
  sessionKey?: string;
  /**
   * Unix permission string (e.g. `-rw-r--r--`) for a remote file, captured from
   * the file-browser listing when the editor was opened. Surfaced in the
   * read-only badge tooltip; `null`/absent when unknown (local files or a
   * backend that does not report permissions). (#1325)
   */
  permissions?: string | null;
  /**
   * When true, the editor is a "scratch" buffer seeded from in-memory content
   * ({@link scratchContent}) instead of being read from disk. Used e.g. to open
   * captured terminal output in an editor that is not yet saved to a file.
   * The buffer is treated as unsaved until the user saves it via Save As.
   */
  scratch?: boolean;
  /** Initial in-memory content for a {@link scratch} editor. */
  scratchContent?: string;
}

export interface ConnectionEditorMeta {
  connectionId: string;
  folderId: string | null;
  /** When set, the editor operates on an agent definition instead of a local connection or agent transport. */
  agentDefinitionId?: string;
  /** Folder on the agent to place a new definition in. */
  agentFolderId?: string | null;
}

export interface TunnelEditorMeta {
  tunnelId: string | null;
}

export interface WorkspaceEditorMeta {
  workspaceId: string | null;
}

/** Which network diagnostic tool to show in a network-diagnostic tab. */
export type NetworkTool =
  | "port-scanner"
  | "ping"
  | "ping-sweep"
  | "dns-lookup"
  | "http-monitor"
  | "traceroute"
  | "wol"
  | "open-ports";

export interface NetworkDiagnosticMeta {
  tool: NetworkTool;
  /** Pre-fill the host/hostname field with this value. */
  prefillHost?: string;
  /** Connection ID that triggered this diagnostic (for context). */
  connectionId?: string;
}

/** Metadata for an agent-error tab shown when a workspace agent connection fails. */
export interface AgentErrorMeta {
  agentId: string;
  agentName: string;
  definitionId: string;
  definitionName: string;
  error: string;
  initialCommand?: string;
}

/**
 * Line ending sent on Enter and used to normalize pasted text.
 * - `cr`   — carriage return (`\r`), classic terminal behavior
 * - `lf`   — line feed (`\n`), typical Unix
 * - `crlf` — carriage return + line feed (`\r\n`), Windows-style
 */
export type LineEnding = "cr" | "lf" | "crlf";

/**
 * Why a terminal session ended, used to tailor the disconnect overlay (#1121).
 *
 * - `clean`   — the process exited normally (exit code 0 / graceful logout).
 * - `dropped` — the process exited non-zero, or the peer/network connection
 *               was lost (unexpected termination).
 * - `killed`  — the user explicitly terminated the session (e.g. via the Open
 *               Connections panel); no "unexpected disconnect" overlay is shown.
 */
export type TerminalExitReason = "clean" | "dropped" | "killed";

/** Details about how a terminal session ended (#1121). */
export interface TerminalExitInfo {
  /** Process exit code, or `null` when unknown (e.g. a dropped connection). */
  code: number | null;
  /** Classified cause used to branch the disconnect overlay's wording. */
  reason: TerminalExitReason;
}

export interface TerminalOptions {
  horizontalScrolling?: boolean;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  scrollbackBuffer?: number;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  /** Per-connection line-ending override. Falls back to the global default. */
  lineEnding?: LineEnding;
  /**
   * Per-connection syntax-highlighting override (epic #1696). Absent → the
   * connection follows the global setting (`override: "global"`). See
   * `services/syntaxHighlightingConfig.ts` → `resolveHighlightingConfig`.
   */
  syntaxHighlighting?: ConnectionHighlightingConfig;
}

/** An external connection file configured for a remote agent. */
export interface ExternalAgentFile {
  /** Absolute path on the remote host. */
  path: string;
  enabled: boolean;
}

/**
 * How a shared remote agent binary is updated when a newer desktop deploys.
 *
 * Only `"immediate"` (hard shutdown + redeploy) is honored today; `"coordinated"`
 * (SI-5) and `"deferred"` (SI-6) persist the preference until those subsystems
 * land. See #1354.
 */
export type UpdateStrategy = "immediate" | "coordinated" | "deferred";

/** SSH transport configuration for a remote agent (no session details). */
export interface RemoteAgentConfig {
  host: string;
  port: number;
  username: string;
  authMethod: "password" | "key" | "agent";
  password?: string;
  keyPath?: string;
  savePassword?: boolean;
  /** Path to the agent binary on the remote host (default: ~/.local/bin/termihub-agent). */
  agentPath?: string;
  /** External connection files to load on the remote host (read-only). */
  externalConnectionFiles?: ExternalAgentFile[];
  /**
   * Whether the agent may check GitHub and update itself in the background.
   * Opt-in; defaults to `false`. The self-update mechanism (SI-8) is not yet
   * implemented — this persists the preference until it lands.
   */
  allowSelfUpdate?: boolean;
  /** Update strategy for this agent's binary. Defaults to `"immediate"`. */
  updateStrategy?: UpdateStrategy;
}

/** Key-value pair for Docker environment variables. */
export interface EnvVar {
  key: string;
  value: string;
}

/** Host-to-container volume mount. */
export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

/**
 * Generic connection configuration for saved connections.
 * The `type` field identifies the connection type (e.g. "ssh", "local"),
 * and `config` holds type-specific settings as unstructured key-value pairs.
 */
export interface ConnectionConfig {
  type: string;
  config: Record<string, unknown>;
}

export interface TerminalTab {
  id: string;
  sessionId: SessionId | null;
  title: string;
  connectionType: ConnectionType;
  contentType: TabContentType;
  config: ConnectionConfig;
  panelId: string;
  isActive: boolean;
  editorMeta?: EditorTabMeta;
  connectionEditorMeta?: ConnectionEditorMeta;
  tunnelEditorMeta?: TunnelEditorMeta;
  workspaceEditorMeta?: WorkspaceEditorMeta;
  networkDiagnosticMeta?: NetworkDiagnosticMeta;
  agentErrorMeta?: AgentErrorMeta;
  /** Set when this tab was launched from a workspace agentRef — enables proper workspace capture. */
  workspaceAgentRef?: { agentId: string; definitionId: string };
  /** Optional command to send after the terminal session connects. */
  initialCommand?: string;
  /**
   * When set, this tab is attached to a persistent background session.
   * Closing the tab detaches from the session (backend process keeps running)
   * rather than terminating it.
   */
  persistentConnectionId?: string;
  /**
   * Id of the saved connection this tab was opened from, when known. Threaded
   * so the on-connect workflow trigger (#1855) can match a freshly opened
   * session back to the connection it came from. Absent for local/unmanaged
   * tabs and externally spawned sessions.
   */
  connectionId?: string;
  /**
   * Set when this tab was opened from an external spawn (`termiHub spawn …`,
   * #1446) as a "new container". Spawned containers have no saved connection id;
   * this flag drives the tab's "Spawned" badge and the separate grouping in the
   * Open Connections panel.
   */
  spawned?: boolean;
  /**
   * Set on a tab hydrated into a destination window by a "move to window"
   * re-parent (#1900). Signals the {@link Terminal} to fetch and replay the
   * session's ring-buffered scrollback once, so the fresh xterm repaints
   * history. Cleared after the first (re)attach.
   */
  pendingScrollbackReplay?: boolean;
}

/**
 * The minimal data needed to reopen a just-closed terminal tab from an
 * Undo/Reopen affordance — a fresh session is created, scrollback is not
 * restored. `null` reopen means the tab had no reconnectable config.
 */
export interface ReopenTabPayload {
  title: string;
  connectionType: ConnectionType;
  config: ConnectionConfig;
}

/**
 * A pending confirmation before tearing down a live session by closing a tab
 * (X / middle-click) or a split panel. The `tab` variant carries the optional
 * {@link ReopenTabPayload} so the follow-up toast can offer Undo/Reopen.
 */
export type SessionCloseConfirmRequest =
  | { kind: "tab"; tabId: string; panelId: string; label: string; reopen: ReopenTabPayload | null }
  | { kind: "panel"; panelId: string; liveCount: number; tabCount: number };

export interface LeafPanel {
  type: "leaf";
  id: string;
  tabs: TerminalTab[];
  activeTabId: string | null;
}

export interface SplitContainer {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: PanelNode[];
  /** Optional percentage sizes for each child (must sum to 100, length must match children). */
  sizes?: number[];
  /** The last leaf that was focused within this subtree. Used by directional navigation. */
  lastActiveLeafId?: string;
}

export type PanelNode = LeafPanel | SplitContainer;
export type DropEdge = "left" | "right" | "top" | "bottom" | "center";

export interface LanguageInfo {
  id: string;
  name: string;
}

export interface EditorStatus {
  line: number;
  column: number;
  language: string;
  availableLanguages: LanguageInfo[];
  eol: "LF" | "CRLF";
  tabSize: number;
  insertSpaces: boolean;
  encoding: string;
}

export interface EditorActions {
  setIndent: (tabSize: number, insertSpaces: boolean) => void;
  toggleEol: () => void;
  setLanguage: (languageId: string) => void;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  target: string;
  message: string;
}

/** A named workspace-level tab group with its own independent panel tree. */
export interface TabGroup {
  id: string;
  name: string;
  /** Optional accent color shown as a dot on the chip. */
  color?: string;
  rootPanel: PanelNode;
  activePanelId: string | null;
}
