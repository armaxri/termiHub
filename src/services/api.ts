/**
 * Tauri command wrappers.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  SessionId,
  ConnectionConfig,
  RemoteAgentConfig,
  LogEntry,
  TerminalOptions,
  LineEnding,
} from "@/types/terminal";
import { XServerConsentDecision, XServerStatusReport } from "@/types/xserver";
import type { RemoteClipboardFile, RemoteDesktopInput } from "@/types/remoteDesktop";
import { CredentialStoreStatusInfo, SwitchCredentialStoreResult } from "@/types/credential";
import type { SpawnRequestPayload } from "@/services/events";
import type { ContainerRuntime, SpawnTarget } from "@/types/spawn";
import type {
  TabHandoffRecord,
  WindowInfo,
  WindowLayoutReport,
  WindowRestorePayload,
} from "@/types/window";
import type { WorkspaceTabGroupDef } from "@/types/workspace";
import {
  SavedConnection,
  ConnectionFolder,
  ConnectionTypeInfo,
  SshConfigImportHost,
  SshConfigImportConnection,
  FileEntry,
  Writability,
  ExternalFileError,
  AppSettings,
  ShellIntegrationStatus,
  ShellIntegrationSettings,
  AgentCapabilities,
  AgentSettings,
  RecoveryWarning,
  AppModeInfo,
  ConfigFileStatus,
  ConfigMigrationResult,
  UpdateInfo,
  UpdateSettings,
} from "@/types/connection";

export type { ConnectionTypeInfo };

// --- Terminal / session commands ---

/** Get the list of available connection types with their schemas. */
export async function getConnectionTypes(): Promise<ConnectionTypeInfo[]> {
  return await invoke<ConnectionTypeInfo[]>("get_connection_types");
}

/**
 * Create a new connection session (type-agnostic).
 *
 * `spawned` marks a CLI/context-menu spawn session (#1446, #1466) so the backend
 * records it on the session registry — the source of truth the Open Connections
 * panel groups "Spawned Containers" from, surviving a tab close.
 */
export async function createConnection(
  typeId: string,
  settings: Record<string, unknown>,
  agentId?: string,
  connectId?: string,
  spawned?: boolean
): Promise<SessionId> {
  return await invoke<string>("create_connection", {
    typeId,
    settings,
    agentId: agentId ?? null,
    connectId: connectId ?? null,
    spawned: spawned ?? false,
  });
}

/**
 * Cancel a session that is still connecting, identified by the `connectId`
 * passed to {@link createTerminal}. Aborts the in-flight handshake promptly
 * instead of waiting out the connect timeout (#952). No-op if the connect
 * already finished. Returns whether a connecting session was found.
 */
export async function cancelConnecting(connectId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_connecting", { connectId });
}

/**
 * Start a live probe of an SSH connection's full path (jump-host hops + target)
 * for the "Show Connection Path" popover (#962).
 *
 * `settings` is the SSH connection's config object (`connection.config.config`).
 * Per-hop status streams back as `jump-host-hop-status` events and a
 * `jump-host-probe-complete` event closes the run, both keyed by `probeId` — use
 * {@link onJumpHostHopStatus} / {@link onJumpHostProbeComplete} to receive them.
 * Cancel an in-flight probe with {@link cancelConnectionPathProbe}.
 */
export async function probeConnectionPath(
  probeId: string,
  settings: Record<string, unknown>
): Promise<void> {
  await invoke("probe_connection_path_cmd", { probeId, settings });
}

/**
 * Cancel an in-flight connection-path probe by its `probeId` (fired when the
 * "Show Connection Path" popover closes). No-op if the probe already finished.
 * Returns whether a probe was active.
 */
export async function cancelConnectionPathProbe(probeId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_connection_path_probe", { probeId });
}

/**
 * Read the user's `~/.ssh/config` (plus any `Include`d files) and return the
 * hosts that declare a `ProxyJump`, with each hop resolved to editor-shaped
 * {@link SshConfigImportHost}s (#1702). Missing / empty / unparseable config
 * degrades to an empty list on the backend — never an error.
 */
export async function importSshConfigHosts(): Promise<SshConfigImportHost[]> {
  return await invoke<SshConfigImportHost[]>("import_ssh_config_hosts");
}

/**
 * Read the user's `~/.ssh/config` (plus any `Include`d files) and return every
 * concrete `Host` alias as a whole, editor-shaped {@link SshConfigImportConnection}
 * — direct hosts and hosts behind a `ProxyJump` alike (#1722). Missing / empty /
 * unparseable config degrades to an empty list on the backend — never an error.
 */
export async function importSshConfigConnections(): Promise<SshConfigImportConnection[]> {
  return await invoke<SshConfigImportConnection[]>("import_ssh_config_connections");
}

/**
 * Create a new terminal session from a ConnectionConfig.
 *
 * For `remote-session` type: extracts `agentId` and `sessionType` from config
 * and forwards the rest as settings. For other types: passes config directly.
 *
 * `connectId` (when provided) lets the caller cancel a still-connecting session
 * via {@link cancelConnecting}. Pass a UNIQUE per-attempt id (e.g.
 * `${tabId}:${retryCount}`), not the bare tab id: overlapping retry/reconnect
 * attempts for the same tab must not share an id, or a stale attempt's cancel
 * would abort a newer in-flight connect (#1125).
 *
 * `spawned` marks a CLI/context-menu spawn session (#1446, #1466) so the backend
 * records the spawned origin on the session registry (the Open Connections panel
 * groups from it, surviving a tab close). Spawn sessions are never
 * `remote-session`, so the flag only applies to the local path.
 */
export async function createTerminal(
  config: ConnectionConfig,
  connectId?: string,
  spawned?: boolean
): Promise<SessionId> {
  if (config.type === "remote-session") {
    const { agentId, sessionType, ...rest } = config.config as {
      agentId: string;
      sessionType: string;
      [key: string]: unknown;
    };
    return await createConnection(sessionType, rest, agentId, connectId);
  }
  return await createConnection(config.type, config.config, undefined, connectId, spawned);
}

/**
 * A resolved directory-mount container spawn (#1372/#1446). Mirrors the Rust
 * `ContainerSpawn`: the camelCase Docker backend `settings` to open the session
 * with, a `"… (Spawned)"` tab `title`, and `spawned: true` so the frontend can
 * badge and track it separately from configured Docker connections.
 */
export interface ContainerSpawn {
  /** Docker backend settings (camelCase) for the spawned session. */
  settings: Record<string, unknown>;
  /** Display title carrying the "Spawned" marker for the tab badge. */
  title: string;
  /** Always `true` — distinguishes spawned containers from saved connections. */
  spawned: boolean;
}

/**
 * Resolve a directory-mount container spawn into Docker session settings
 * (#1446/#1447). Given a spawn `location` (and optional triggering `entryId` +
 * image / mount overrides), returns the Docker settings + tab title used to open
 * a "new container" tab with the target directory bind-mounted. When no explicit
 * image / mount is given, the backend honors the saved per-entry preference of
 * the entry addressed by `entryId` before falling back to the built-in defaults.
 *
 * `runtime` pins Docker or Podman — the Session Picker's choice (SI-3, #1366).
 * Omit it to keep the pre-picker behaviour of auto-detecting whichever runtime
 * is installed.
 */
export async function resolveContainerSpawn(
  location: string,
  entryId?: string,
  containerImage?: string,
  containerMount?: string,
  runtime?: ContainerRuntime
): Promise<ContainerSpawn> {
  return await invoke<ContainerSpawn>("resolve_container_spawn", {
    location,
    entryId,
    containerImage,
    containerMount,
    runtime: runtime ?? null,
  });
}

/**
 * A resolved local/WSL/SSH shell spawn (#1365, SI-2). Mirrors the Rust
 * `ShellSpawn`: the camelCase local-shell backend `settings` (with the resolved
 * target as `startingDirectory`) to open the session with, a `"… (Spawned)"` tab
 * `title`, `spawned: true` so it is tracked separately from saved connections,
 * and `missing: true` when the requested path did not exist and the home
 * directory was substituted.
 */
export interface ShellSpawn {
  /**
   * Backend session type to open: `"local"` shell, `"wsl"` distribution, or
   * `"ssh"` saved connection (#1511). Absent on legacy payloads → treated as
   * `"local"`.
   */
  type?: "local" | "wsl" | "ssh";
  /** Backend settings (camelCase) for the spawned session. */
  settings: Record<string, unknown>;
  /** Display title carrying the "Spawned" marker for the tab badge. */
  title: string;
  /** Always `true` — distinguishes spawned shells from saved connections. */
  spawned: boolean;
  /** `true` when the requested path was missing and home was substituted. */
  missing: boolean;
  /**
   * For an SSH spawn: absolute path to `cd` into once the session connects
   * (SSH cannot set a start cwd at spawn). Absent for local/WSL spawns. (#1511)
   */
  cdPath?: string;
}

/**
 * Resolve an external local/WSL/SSH spawn into the correct backend session
 * settings (#1365 local, #1511 WSL/SSH). Dispatches on `kind`:
 *
 * - **local** — the resolved working directory becomes a local shell's
 *   `startingDirectory` (folder → itself, file → parent, missing → home).
 * - **wsl** — a `wsl` session at the `/mnt/`-converted path, distribution from
 *   the saved WSL connection (`connection`) or the system default distro.
 * - **ssh** — the saved SSH connection (`connection`) opened verbatim, with the
 *   target path returned as `cdPath` to `cd` into after connect.
 *
 * `shell` names the specific target within the `kind` — a local shell name, or a
 * WSL distribution — as chosen in the Session Picker (SI-3, #1366). It outranks
 * the `connection` / system-default fallbacks. Omit it to keep the pre-picker
 * behaviour of opening the system default.
 *
 * Rejects (throws) an SSH/WSL spawn that cannot be resolved to a
 * connection/distribution, so the caller can surface an error toast.
 */
export async function resolveShellSpawn(
  location?: string,
  connection?: string,
  entryId?: string,
  kind?: string,
  shell?: string
): Promise<ShellSpawn> {
  return await invoke<ShellSpawn>("resolve_shell_spawn", {
    location,
    connection,
    entryId,
    kind,
    shell: shell ?? null,
  });
}

/**
 * Drain the cold-start pending spawn, if any (#1365). A freshly-launched
 * instance parks a spawn handed to it before the UI was ready; the frontend
 * calls this once its `spawn-request` subscription is registered to pick it up.
 * Returns `null` when nothing is pending.
 */
export async function takePendingSpawn(): Promise<SpawnRequestPayload | null> {
  return await invoke<SpawnRequestPayload | null>("take_pending_spawn");
}

// ── Multi-window foundation (#1900) ───────────────────────────────────────

/**
 * Open a new native window loading the same frontend bundle. When a hand-off
 * record is supplied, it is queued for the new window to drain on boot; when a
 * restore payload is supplied, its tab groups are queued for the new window to
 * hydrate on boot (multi-window restore, #1925). Returns the new window's unique
 * label.
 */
export async function openWindow(
  handoff?: TabHandoffRecord,
  restore?: WindowRestorePayload
): Promise<string> {
  return await invoke<string>("open_window", {
    handoff: handoff ?? null,
    restore: restore ?? null,
  });
}

/**
 * Claim a session for the *calling* window (grant side of the ownership
 * handshake). Returns the previous owner's label, if any.
 */
export async function claimSession(sessionId: string): Promise<string | null> {
  return await invoke<string | null>("claim_session", { sessionId });
}

/** Release a session from the *calling* window. No-op unless it is the owner. */
export async function releaseSession(sessionId: string): Promise<boolean> {
  return await invoke<boolean>("release_session", { sessionId });
}

/** The window label currently rendering a session, if any. */
export async function getSessionOwner(sessionId: string): Promise<string | null> {
  return await invoke<string | null>("get_session_owner", { sessionId });
}

/** List all currently open windows, each with its last-reported tab count. */
export async function listWindows(): Promise<WindowInfo[]> {
  return await invoke<WindowInfo[]>("list_windows");
}

/**
 * Report the *calling* window's current tab count so other windows'
 * "Move to Window ▸" pickers can show a live "N tabs" hint (#1910). Nudges every
 * window with `windows-changed` so an open picker refreshes.
 */
export async function reportWindowTabCount(count: number): Promise<void> {
  await invoke("report_window_tab_count", { count });
}

/**
 * Take (and clear) the hand-off records queued for the *calling* window — the
 * destination window's drain on boot / on a `window-handoff` nudge.
 */
export async function takePendingHandoffs(): Promise<TabHandoffRecord[]> {
  return await invoke<TabHandoffRecord[]>("take_pending_handoffs");
}

/**
 * Queue a hand-off record for an already-open window and nudge every window to
 * drain its queue (global `window-handoff` event).
 */
export async function sendHandoffToWindow(
  targetLabel: string,
  handoff: TabHandoffRecord
): Promise<void> {
  await invoke("send_handoff_to_window", { targetLabel, handoff });
}

/**
 * Report this window's captured layout slice to the multi-window aggregation
 * authority (#1925) so the main window can assemble the full persisted document
 * it cannot see across the JS-context boundary.
 */
export async function reportWindowLayout(
  tabGroups: WorkspaceTabGroupDef[],
  activeGroupIndex: number
): Promise<void> {
  await invoke("report_window_layout", { tabGroups, activeGroupIndex });
}

/**
 * Every open window's reported layout slice, main-window-first — the main window
 * assembles the full multi-window last-session / workspace document from these
 * (#1925).
 */
export async function collectWindowLayouts(): Promise<WindowLayoutReport[]> {
  return await invoke<WindowLayoutReport[]>("collect_window_layouts");
}

/**
 * Take (and clear) the tab groups this window should hydrate on boot when it was
 * spawned by a multi-window restore (#1925). `null` for a window that was not
 * restore-spawned.
 */
export async function takePendingWindowRestore(): Promise<WindowRestorePayload | null> {
  return await invoke<WindowRestorePayload | null>("take_pending_window_restore");
}

/**
 * Fetch a session's captured scrollback so a freshly-created xterm in a
 * destination window can repaint history after a re-parent. Empty when nothing
 * has been captured or the session is unknown.
 */
export async function replaySessionScrollback(sessionId: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("replay_session_scrollback", { sessionId });
  return new Uint8Array(bytes);
}

/**
 * The spawn targets available on this host (SI-3, #1366). Mirrors the Rust
 * `SpawnOptions`: every list is "what exists right now", so the Session Picker
 * renders a section per non-empty group. `wslDistros` is always empty off
 * Windows, and an image list is only populated when its runtime is available.
 */
export interface SpawnOptions {
  /** Local shells detected on this host (e.g. `"bash"`, `"zsh"`). */
  shells: string[];
  /** Installed WSL distributions. Always empty off Windows. */
  wslDistros: string[];
  /** Whether a usable Docker daemon responded. */
  dockerAvailable: boolean;
  /** Local Docker images (`repository:tag`). Empty unless `dockerAvailable`. */
  dockerImages: string[];
  /** Whether a usable Podman runtime responded. */
  podmanAvailable: boolean;
  /** Local Podman images (`repository:tag`). Empty unless `podmanAvailable`. */
  podmanImages: string[];
}

/**
 * Enumerate the spawn targets the Session Picker can offer (SI-3, #1366).
 * Called when the picker opens so it reflects the host's live state — shells,
 * WSL distributions and the images of whichever container runtimes respond.
 */
export async function listSpawnOptions(): Promise<SpawnOptions> {
  return await invoke<SpawnOptions>("list_spawn_options");
}

/** Send input data to a terminal session */
export async function sendInput(sessionId: SessionId, data: string): Promise<void> {
  await invoke("send_input", { sessionId, data });
}

/**
 * Set the line ending applied to a session's interactive input (Enter / paste).
 * The backend normalizes all input on `send_input` to this ending.
 */
export async function setSessionLineEnding(
  sessionId: SessionId,
  lineEnding: LineEnding
): Promise<void> {
  await invoke("set_session_line_ending", { sessionId, lineEnding });
}

/** Resize a terminal session */
export async function resizeTerminal(
  sessionId: SessionId,
  cols: number,
  rows: number
): Promise<void> {
  await invoke("resize_terminal", { sessionId, cols, rows });
}

/** Close a terminal session */
export async function closeTerminal(sessionId: SessionId): Promise<void> {
  await invoke("close_terminal", { sessionId });
}

// --- Remote-desktop (graphical) commands (#1680) ---

/**
 * Open a graphical remote-desktop session for a connection type (`mock-remote-desktop`,
 * `vnc`, `rdp`, …). Returns the new graphical session id. Frames/cursor/state
 * arrive via the `remote-desktop-*` events.
 */
export async function remoteDesktopConnect(
  typeId: string,
  settings: Record<string, unknown>
): Promise<SessionId> {
  return await invoke<string>("remote_desktop_connect", { typeId, settings });
}

/** Request a new session resolution in pixels (Match Window / dynamic resize). */
export async function remoteDesktopResize(
  sessionId: SessionId,
  width: number,
  height: number
): Promise<void> {
  await invoke("remote_desktop_resize", { sessionId, width, height });
}

/**
 * Ask the backend to re-emit a full framebuffer frame (#1904).
 *
 * Invoked when a graphical tab is moved into another window: the destination
 * canvas is blank until the next full frame, so this forces a prompt repaint
 * instead of waiting for the protocol's next natural keyframe.
 */
export async function remoteDesktopRequestFullFrame(sessionId: SessionId): Promise<void> {
  await invoke("remote_desktop_request_full_frame", { sessionId });
}

/** Forward a protocol-agnostic input event (key / pointer / wheel). */
export async function remoteDesktopSendInput(
  sessionId: SessionId,
  event: RemoteDesktopInput
): Promise<void> {
  await invoke("remote_desktop_send_input", { sessionId, event });
}

/** Push local clipboard text to the remote. */
export async function remoteDesktopSendClipboard(
  sessionId: SessionId,
  text: string
): Promise<void> {
  await invoke("remote_desktop_send_clipboard", { sessionId, text });
}

/** Read the remote clipboard text, if any. */
export async function remoteDesktopGetClipboard(sessionId: SessionId): Promise<string | null> {
  return await invoke<string | null>("remote_desktop_get_clipboard", { sessionId });
}

/**
 * List the files the remote most recently copied to its clipboard, surfaced for a
 * local paste with delayed rendering (#1804).
 *
 * Empty on any platform without an OS-clipboard delayed-render binding (the
 * sidecar keeps eagerly downloading files into the shared folder there), or when
 * the remote copied text / an image / nothing. The bytes are fetched only on the
 * actual paste — see {@link remoteDesktopBindClipboardFiles}.
 */
export async function remoteDesktopRemoteClipboardFiles(
  sessionId: SessionId
): Promise<RemoteClipboardFile[]> {
  return await invoke<RemoteClipboardFile[]>("remote_desktop_remote_clipboard_files", {
    sessionId,
  });
}

/**
 * Bind the remote-copied clipboard files onto the host OS clipboard so they can be
 * pasted into any local app (#1804). Returns the number of files bound.
 *
 * Installs a delayed-render promise: no bytes are fetched here — each file is
 * streamed from the remote only when the user actually pastes. Returns `0` when
 * the remote copied no pasteable files; rejects on a platform without a native
 * binding.
 */
export async function remoteDesktopBindClipboardFiles(sessionId: SessionId): Promise<number> {
  return await invoke<number>("remote_desktop_bind_clipboard_files", { sessionId });
}

/**
 * Deliver the user's verdict for an interactive certificate-trust prompt (#1767).
 *
 * `accept` proceeds with the untrusted server certificate; `remember` persists
 * its fingerprint so the host is trusted (not re-prompted) on future connects.
 */
export async function remoteDesktopCertDecision(
  sessionId: SessionId,
  accept: boolean,
  remember: boolean
): Promise<void> {
  await invoke("remote_desktop_cert_decision", { sessionId, accept, remember });
}

/** Disconnect a graphical remote-desktop session. */
export async function remoteDesktopDisconnect(sessionId: SessionId): Promise<void> {
  await invoke("remote_desktop_disconnect", { sessionId });
}

/** One remembered RDP host and the certificate fingerprints trusted for it (#1784). */
export interface RdpTrustedHost {
  host: string;
  fingerprints: string[];
}

/**
 * List remembered RDP hosts and their trusted certificate fingerprints (#1784).
 *
 * These are the hosts a user chose "Accept for host" for in the interactive
 * cert-trust prompt (#1767); the trust-management settings UI reviews them.
 */
export async function rdpTrustList(): Promise<RdpTrustedHost[]> {
  return await invoke<RdpTrustedHost[]>("rdp_trust_list");
}

/**
 * Revoke a remembered RDP certificate (#1784). Pass a `fingerprint` to forget
 * just that one (the host is dropped once its last fingerprint is gone); omit it
 * to forget the whole host. Either way the next connect to that host re-prompts.
 * Returns whether anything was removed.
 */
export async function rdpTrustForget(host: string, fingerprint?: string): Promise<boolean> {
  return await invoke<boolean>("rdp_trust_forget", { host, fingerprint: fingerprint ?? null });
}

// --- Persistent session commands ---

/** Summary of a persistent session returned by the backend. */
export interface PersistentSessionSummary {
  connectionId: string;
  sessionId: string;
  attachedTabCount: number;
}

/**
 * Start a persistent background session for a saved connection.
 * Returns the backend session ID. Idempotent: if the session is already
 * running the existing session ID is returned.
 */
export async function startPersistentSession(
  connectionId: string,
  typeId: string,
  settings: Record<string, unknown>,
  agentId?: string
): Promise<SessionId> {
  return await invoke<string>("start_persistent_session", {
    connectionId,
    typeId,
    settings,
    agentId,
  });
}

/**
 * Stop a persistent session, terminating the background process.
 * All attached tabs will receive a terminal-exit event.
 */
export async function stopPersistentSession(connectionId: string): Promise<void> {
  await invoke("stop_persistent_session", { connectionId });
}

/**
 * Adopt an already-running agent session into the desktop's persistent registry.
 *
 * Used when the sidebar's Active Sessions list surfaces a session the desktop
 * does not yet track (e.g. discovered after a tab close or app restart). After
 * adoption, `attachPersistentTab` can re-attach to it with scrollback replay.
 *
 * Returns the agent session ID (echoed back on success).
 */
export async function adoptPersistentSession(
  connectionId: string,
  agentId: string,
  agentSessionId: string
): Promise<SessionId> {
  return await invoke<string>("adopt_persistent_session", {
    connectionId,
    agentId,
    agentSessionId,
  });
}

/**
 * Register `tabId` as attached to the persistent session for `connectionId`.
 * Returns the new attached-tab count.
 */
export async function attachPersistentTab(connectionId: string, tabId: string): Promise<number> {
  return await invoke<number>("attach_persistent_tab", { connectionId, tabId });
}

/**
 * Unregister `tabId` from its persistent session, keeping the process alive.
 * Returns the new attached-tab count.
 */
export async function detachPersistentTab(sessionId: SessionId, tabId: string): Promise<number> {
  return await invoke<number>("detach_persistent_tab", { sessionId, tabId });
}

/** Return all currently registered persistent sessions. */
export async function listPersistentSessions(): Promise<PersistentSessionSummary[]> {
  return await invoke<PersistentSessionSummary[]>("list_persistent_sessions");
}

/** Fetch the scrollback buffer for a persistent session from the agent daemon. */
export async function getAgentSessionBuffer(sessionId: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("get_agent_session_buffer", { sessionId });
  return new Uint8Array(bytes);
}

/** Info about a local session managed by the desktop. */
export interface LocalSessionInfo {
  id: string;
  title: string;
  connectionType: string;
  alive: boolean;
  agentId?: string;
  /**
   * `true` when the session was opened via the CLI/context-menu spawn path
   * (#1446, #1466) — a container with no saved connection id. This is the
   * authoritative backend marker the Open Connections panel groups from, so a
   * spawned container stays under "Spawned Containers" even after its owning
   * tab (and the frontend-only `spawned` tab flag) is gone. Absent for
   * sessions created before this field existed → treated as `false`.
   */
  spawned?: boolean;
}

/** List all active local sessions (includes remote proxy sessions). */
export async function listLocalSessions(): Promise<LocalSessionInfo[]> {
  return await invoke<LocalSessionInfo[]>("list_local_sessions");
}

/** List available serial ports */
export async function listSerialPorts(): Promise<string[]> {
  return await invoke<string[]>("list_serial_ports");
}

/** List available shells on this platform */
export async function listAvailableShells(): Promise<string[]> {
  return await invoke<string[]>("list_available_shells");
}

/** Detect the user's default shell on this platform */
export async function getDefaultShell(): Promise<string | null> {
  return await invoke<string | null>("get_default_shell");
}

/** Check if a local X server is available for X11 forwarding */
export async function checkX11Available(): Promise<boolean> {
  return await invoke<boolean>("check_x11_available");
}

/** Get the status of the shared X server that termiHub manages or has adopted. */
export async function xServerStatus(): Promise<XServerStatusReport> {
  return await invoke<XServerStatusReport>("x_server_status");
}

/** Stop the termiHub-managed X server. Rejects with an XServerError on failure. */
export async function xServerStop(): Promise<void> {
  return await invoke<void>("x_server_stop");
}

/**
 * Resolve or provision the shared X server (adopt an external one, or download
 * and launch the managed one). Emits `x-server-progress` events while running
 * and resolves with the final status. Rejects with a typed `XServerError` on
 * failure.
 */
export async function xServerEnsure(): Promise<XServerStatusReport> {
  return await invoke<XServerStatusReport>("x_server_ensure");
}

/**
 * Install the platform X server dependency (e.g. VcXsrv) when provisioning
 * reported it missing. Rejects with a typed `XServerError` carrying guidance
 * when the install cannot proceed automatically.
 */
export async function xServerInstallDependency(): Promise<void> {
  await invoke("x_server_install_dependency");
}

/**
 * Reply to a connect-time X server download-consent prompt (#1116), waking the
 * SSH connect paused on `id`. `decision` is `enable` (download/provision and
 * remember) or `notNow` (skip X forwarding this connect). Resolves `true` when a
 * paused connect matched the id, `false` when it was already resolved or unknown.
 */
export async function xServerConnectConsentReply(
  id: string,
  decision: XServerConsentDecision
): Promise<boolean> {
  return await invoke<boolean>("x_server_connect_consent_reply", { id, decision });
}

/** Check whether the SSH agent is running, stopped, or not installed. */
export async function checkSshAgentStatus(): Promise<string> {
  return await invoke<string>("check_ssh_agent_status");
}

/** Result of validating an SSH key file path. */
export interface SshKeyValidation {
  status: "valid" | "warning" | "error";
  message: string;
  keyType: string;
}

/** Validate an SSH key file path and return a user-facing hint. */
export async function validateSshKey(path: string): Promise<SshKeyValidation> {
  return await invoke<SshKeyValidation>("validate_ssh_key", { path });
}

/**
 * Whether an SSH private key file is passphrase-encrypted.
 *
 * Used to decide whether to prompt for a key passphrase at connect time based
 * on the key's actual encryption rather than the "Save password" flag (#885).
 * Rejects when the file cannot be read — callers should then prompt anyway so
 * an encrypted key never fails to connect silently.
 */
export async function isSshKeyEncrypted(path: string): Promise<boolean> {
  return await invoke<boolean>("is_ssh_key_encrypted", { path });
}

/** Check if Docker is available on the local system. */
export async function checkDockerAvailable(): Promise<boolean> {
  return await invoke<boolean>("check_docker_available");
}

/** List locally available Docker images. */
export async function listDockerImages(): Promise<string[]> {
  return await invoke<string[]>("list_docker_images");
}

/** Check if Podman is available on the local system. */
export async function checkPodmanAvailable(): Promise<boolean> {
  return await invoke<boolean>("check_podman_available");
}

/** List locally available Podman images. */
export async function listPodmanImages(): Promise<string[]> {
  return await invoke<string[]>("list_podman_images");
}

// --- Connection persistence commands ---

/** Saved remote agent (persisted form, no ephemeral state). */
export interface SavedRemoteAgent {
  id: string;
  name: string;
  config: RemoteAgentConfig;
  agentSettings: AgentSettings;
}

interface ConnectionData {
  connections: SavedConnection[];
  folders: ConnectionFolder[];
  agents: SavedRemoteAgent[];
  externalErrors: ExternalFileError[];
}

/** Load all saved connections and folders from disk */
export async function loadConnectionsAndFolders(): Promise<ConnectionData> {
  return await invoke<ConnectionData>("load_connections_and_folders");
}

/** Save (add or update) a connection, returning its persisted (recomputed) id. */
export async function saveConnection(connection: SavedConnection): Promise<string> {
  return await invoke<string>("save_connection", { connection });
}

/** Delete a connection by ID, optionally from an external file */
export async function deleteConnectionFromBackend(
  id: string,
  sourceFile?: string | null
): Promise<void> {
  await invoke("delete_connection", { id, sourceFile: sourceFile ?? null });
}

/** Move a connection between storage files */
export async function moveConnectionToFile(
  connectionId: string,
  currentSource: string | null,
  targetSource: string | null
): Promise<SavedConnection> {
  return await invoke<SavedConnection>("move_connection_to_file", {
    connectionId,
    currentSource,
    targetSource,
  });
}

/** Save (add or update) a folder */
export async function saveFolder(folder: ConnectionFolder): Promise<void> {
  await invoke("save_folder", { folder });
}

/** Delete a folder by ID */
export async function deleteFolderFromBackend(id: string): Promise<void> {
  await invoke("delete_folder", { id });
}

/** Export all connections as a JSON string */
export async function exportConnections(): Promise<string> {
  return await invoke<string>("export_connections");
}

/** Import connections from a JSON string. Returns count imported. */
export async function importConnections(json: string): Promise<number> {
  return await invoke<number>("import_connections", { json });
}

/** Preview of an import file before the user confirms. */
export interface ImportPreview {
  connectionCount: number;
  folderCount: number;
  agentCount: number;
  hasEncryptedCredentials: boolean;
}

/** Result of a completed import operation. */
export interface ImportResult {
  connectionsImported: number;
  credentialsImported: number;
}

/** Preview the contents of an import file without performing the import. */
export async function previewImport(json: string): Promise<ImportPreview> {
  return await invoke<ImportPreview>("preview_import", { json });
}

/** Export connections with optional encrypted credentials. */
export async function exportConnectionsEncrypted(
  exportPassword: string | null,
  connectionIds: string[] | null
): Promise<string> {
  return await invoke<string>("export_connections_encrypted", {
    exportPassword,
    connectionIds,
  });
}

/** Import connections with optional credential decryption. */
export async function importConnectionsWithCredentials(
  json: string,
  importPassword: string | null
): Promise<ImportResult> {
  return await invoke<ImportResult>("import_connections_with_credentials", {
    json,
    importPassword,
  });
}

/** Drain and return any recovery warnings from app startup. */
export async function getRecoveryWarnings(): Promise<RecoveryWarning[]> {
  return await invoke<RecoveryWarning[]>("get_recovery_warnings");
}

// --- Settings commands ---

/** Get the current application settings */
export async function getSettings(): Promise<AppSettings> {
  return await invoke<AppSettings>("get_settings");
}

/** Update and persist application settings */
export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

/**
 * Get the current shell-integration registration + staleness status
 * (registered state, whether the recorded exe path matches the current
 * executable, portable-mode flag, and detected file managers).
 */
export async function getShellIntegrationStatus(): Promise<ShellIntegrationStatus> {
  return await invoke<ShellIntegrationStatus>("get_shell_integration_status");
}

/**
 * Persist the shell-integration settings and, when the integration is currently
 * registered, refresh the OS context-menu registration so it reflects the edited
 * entries. Returns the recomputed registration + staleness status.
 */
export async function saveShellIntegrationSettings(
  shellIntegration: ShellIntegrationSettings
): Promise<ShellIntegrationStatus> {
  return await invoke<ShellIntegrationStatus>("save_shell_integration_settings", {
    shellIntegration,
  });
}

/**
 * Persist the Session Picker's "Remember this choice" (#1561): save the picked
 * target onto the entry that triggered the spawn, so a later context-menu click
 * opens it directly instead of prompting again. Re-registers the OS context menu
 * when the integration is registered, since the remembered kind is part of the
 * command line the surface invokes. An unknown `entryId` is a no-op.
 */
export async function rememberSpawnChoice(
  entryId: string,
  target: SpawnTarget
): Promise<ShellIntegrationStatus> {
  return await invoke<ShellIntegrationStatus>("remember_spawn_choice", {
    entryId,
    target,
  });
}

/**
 * Register the configured entries as OS file-manager context-menu items and
 * persist the updated registration status. Returns the refreshed status.
 */
export async function installShellIntegration(): Promise<ShellIntegrationStatus> {
  return await invoke<ShellIntegrationStatus>("install_shell_integration");
}

/**
 * Remove all OS file-manager context-menu registrations and persist the updated
 * registration status. Returns the refreshed status.
 */
export async function uninstallShellIntegration(): Promise<ShellIntegrationStatus> {
  return await invoke<ShellIntegrationStatus>("uninstall_shell_integration");
}

/** Save an external connection file to disk */
export async function saveExternalFile(
  filePath: string,
  name: string,
  folders: ConnectionFolder[],
  connections: SavedConnection[]
): Promise<void> {
  await invoke("save_external_file", { filePath, name, folders, connections });
}

/** Reload external connection files */
export async function reloadExternalConnections(): Promise<SavedConnection[]> {
  return await invoke<SavedConnection[]>("reload_external_connections");
}

// --- SFTP commands ---

/** Open a new SFTP session. Returns session ID. */
export async function sftpOpen(config: Record<string, unknown>): Promise<string> {
  return await invoke<string>("sftp_open", { config });
}

/** Close an SFTP session. */
export async function sftpClose(sessionId: string): Promise<void> {
  await invoke("sftp_close", { sessionId });
}

/** List directory contents via SFTP. */
export async function sftpListDir(sessionId: string, path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("sftp_list_dir", { sessionId, path });
}

/**
 * Get metadata (size, mtime, permissions) for a single remote file via SFTP.
 *
 * Backs the editor's remote external-change detection (#1627): a stat is a
 * single metadata round-trip, so it is the cheap poll primitive used to spot an
 * out-of-band change before deciding to re-read the file.
 */
export async function sftpStat(sessionId: string, path: string): Promise<FileEntry> {
  return await invoke<FileEntry>("sftp_stat", { sessionId, path });
}

/**
 * Resolve a remote path to its canonical absolute form via SFTP realpath.
 *
 * Pass `"."` to resolve the session's home directory instead of guessing
 * `/home/<user>` (audit GAP C2).
 */
export async function sftpRealpath(sessionId: string, path: string): Promise<string> {
  return await invoke<string>("sftp_realpath", { sessionId, path });
}

/** Lifecycle phase of an SFTP transfer (see `transfer-progress` event). */
export type TransferPhase = "transferring" | "done" | "cancelled" | "error";

/**
 * Rich queue state of a transfer (#1336). Emitted alongside the legacy
 * {@link TransferPhase} `phase`; the queue-aware UI prefers `state`.
 */
export type TransferQueueState =
  | "queued"
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Payload of the `transfer-progress` event emitted per transfer.
 *
 * The #1245 fields (`phase`, `total`, …) are unchanged for backward
 * compatibility with the existing SFTP consumers. The queue model (#1336) adds
 * the optional `state`/`speed`/`totalBytes`/`etaSecs`/`attempt`/`maxAttempts`
 * fields, populated for both SFTP (derived) and FTP (measured) transfers.
 */
export interface TransferProgress {
  transferId: string;
  sessionId: string;
  direction: "download" | "upload";
  fileName: string;
  /** Remote path of the transferred file (e.g. `/uploads/data.csv`), when the
   * backend supplies one — shown in the Transfer Queue row (#1531). */
  path?: string;
  transferred: number;
  total: number;
  phase: TransferPhase;
  message?: string;
  /** Rich queue state (#1336). */
  state?: TransferQueueState;
  /** Throughput in bytes/sec (`0` = unknown). */
  speed?: number;
  /** Total size in bytes (mirror of `total`; `0` = indeterminate). */
  totalBytes?: number;
  /** Estimated seconds remaining, when a speed is known. */
  etaSecs?: number;
  /** Retry attempt number (0 when not retrying). */
  attempt?: number;
  /** Maximum retry attempts before permanent failure. */
  maxAttempts?: number;
}

/**
 * A snapshot of one queued transfer, returned by {@link transferList} (#1336).
 */
export interface TransferSnapshot {
  transferId: string;
  sessionId: string;
  direction: "download" | "upload";
  fileName: string;
  /** Remote path of the transferred file, when the backend supplies one (#1531). */
  path?: string;
  state: TransferQueueState;
  /**
   * Whether this snapshot is a *genuinely* settled outcome the reconcile may
   * fold into a stuck row (#1657). Stricter than `isTerminalTransferState`: a
   * live rich (FTP) transfer that is momentarily `failed` mid auto-retry — or
   * awaiting a manual retry — reports `state: "failed"` with `settled: false`,
   * so a transient failure is never reconciled into a terminal `failed` row.
   */
  settled: boolean;
  transferred: number;
  total: number;
  speed: number;
  attempt: number;
  maxAttempts: number;
}

/**
 * Rejection raised by {@link awaitTransfer} when a transfer settles via a
 * terminal `transfer-progress` event (`cancelled` / `error`), as opposed to an
 * early/synchronous failure that never reached the background transfer.
 *
 * The terminal success/error toast is owned exclusively by the
 * `transfer-progress` event path (`useTransferEvents`, #1286) so a single
 * transfer yields exactly one toast. Callers such as `runTransfer` use this
 * marker to recognise "the event path already surfaced this outcome" and skip
 * their own terminal toast (they just dismiss their pending toast), while still
 * surfacing early failures that produced no transfer event.
 */
export class TransferTerminalError extends Error {
  /** `"cancelled"` when the user aborted; `"error"` on a real failure. */
  readonly phase: "cancelled" | "error";

  constructor(phase: "cancelled" | "error", message: string) {
    super(message);
    this.name = "TransferTerminalError";
    this.phase = phase;
  }
}

/**
 * Await the terminal `transfer-progress` event for `transferId`.
 *
 * The backend now runs transfers in the background on a dedicated channel and
 * returns a `transferId` synchronously (#1245). This bridges that fire-and-return
 * command to the existing await-completion callers: it resolves with the bytes
 * transferred on `done`, and rejects with a {@link TransferTerminalError} on
 * `cancelled` / `error`. The D3 UI can instead subscribe to `transfer-progress`
 * directly for live progress.
 */
async function awaitTransfer(transferId: string): Promise<number> {
  const { listen } = await import("@tauri-apps/api/event");
  return await new Promise<number>((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    void listen<TransferProgress>("transfer-progress", (event) => {
      const p = event.payload;
      if (p.transferId !== transferId) return;
      if (p.phase === "done") {
        unlisten?.();
        resolve(p.transferred);
      } else if (p.phase === "cancelled") {
        unlisten?.();
        reject(new TransferTerminalError("cancelled", "Transfer cancelled"));
      } else if (p.phase === "error") {
        unlisten?.();
        reject(new TransferTerminalError("error", p.message ?? "Transfer failed"));
      }
    }).then((fn) => {
      unlisten = fn;
    });
  });
}

/**
 * Download a remote file to a local path.
 *
 * Registers a background transfer on a dedicated channel and resolves with the
 * bytes transferred once it completes (#1245).
 *
 * `onRegistered` fires once with the backend `transferId` the instant the start
 * command returns — over the reliable request/response channel, before any
 * best-effort `transfer-progress` event. Callers use it to seed the Transfer
 * Queue so the panel opens even if progress events are dropped/delayed under
 * memory pressure (#1632).
 */
export async function sftpDownload(
  sessionId: string,
  remotePath: string,
  localPath: string,
  onRegistered?: (transferId: string) => void
): Promise<number> {
  const transferId = await invoke<string>("sftp_download", {
    sessionId,
    remotePath,
    localPath,
  });
  onRegistered?.(transferId);
  return await awaitTransfer(transferId);
}

/**
 * Upload a local file to a remote path.
 *
 * Registers a background transfer on a dedicated channel and resolves with the
 * bytes transferred once it completes (#1245).
 *
 * `onRegistered` fires once with the backend `transferId` the instant the start
 * command returns (see {@link sftpDownload}), for seeding the Transfer Queue
 * ahead of any progress event (#1632).
 */
export async function sftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onRegistered?: (transferId: string) => void
): Promise<number> {
  const transferId = await invoke<string>("sftp_upload", {
    sessionId,
    localPath,
    remotePath,
  });
  onRegistered?.(transferId);
  return await awaitTransfer(transferId);
}

/** Cancel an in-flight SFTP transfer. Unknown/finished ids are a no-op (#1245). */
export async function sftpCancelTransfer(transferId: string): Promise<void> {
  await invoke("sftp_cancel_transfer", { transferId });
}

// --- Generic transfer-queue controls (#1336) ---

/** Pause an in-flight transfer. Unknown ids are a no-op. */
export async function transferPause(transferId: string): Promise<void> {
  await invoke("transfer_pause", { transferId });
}

/** Resume a paused transfer. Unknown ids are a no-op. */
export async function transferResume(transferId: string): Promise<void> {
  await invoke("transfer_resume", { transferId });
}

/** Cancel a transfer (queued, active, or paused). Unknown ids are a no-op. */
export async function transferCancel(transferId: string): Promise<void> {
  await invoke("transfer_cancel", { transferId });
}

/** Manually retry a failed transfer. Unknown ids are a no-op. */
export async function transferRetry(transferId: string): Promise<void> {
  await invoke("transfer_retry", { transferId });
}

/** List queued transfers, optionally filtered by session. */
export async function transferList(sessionId?: string): Promise<TransferSnapshot[]> {
  return await invoke<TransferSnapshot[]>("transfer_list", { sessionId });
}

/**
 * Register an FTP download (remote → local). Returns the `transferId`; progress
 * is reported via `transfer-progress` events (#1336).
 */
export async function ftpDownload(
  sessionId: string,
  config: unknown,
  remotePath: string,
  localPath: string
): Promise<string> {
  return await invoke<string>("ftp_download", {
    sessionId,
    config,
    remotePath,
    localPath,
  });
}

/**
 * Register an FTP upload (local → remote). Returns the `transferId`; progress is
 * reported via `transfer-progress` events (#1336).
 */
export async function ftpUpload(
  sessionId: string,
  config: unknown,
  localPath: string,
  remotePath: string
): Promise<string> {
  return await invoke<string>("ftp_upload", {
    sessionId,
    config,
    localPath,
    remotePath,
  });
}

/** Create a directory on the remote host. */
export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  await invoke("sftp_mkdir", { sessionId, path });
}

/** Delete a file or directory on the remote host. */
export async function sftpDelete(
  sessionId: string,
  path: string,
  isDirectory: boolean
): Promise<void> {
  await invoke("sftp_delete", { sessionId, path, isDirectory });
}

/** Rename a file or directory on the remote host. */
export async function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  await invoke("sftp_rename", { sessionId, oldPath, newPath });
}

// --- Local filesystem commands ---

/** Return the current user's home directory path. */
export async function getHomeDir(): Promise<string> {
  return await invoke<string>("get_home_dir");
}

/** List directory contents on the local filesystem. */
export async function localListDir(path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("local_list_dir", { path });
}

/** Copy a file or directory on the local filesystem. */
export async function localCopyFile(
  srcPath: string,
  destPath: string,
  isDirectory: boolean
): Promise<void> {
  await invoke("local_copy", { srcPath, destPath, isDirectory });
}

/** Create a directory on the local filesystem. */
export async function localMkdir(path: string): Promise<void> {
  await invoke("local_mkdir", { path });
}

/** Delete a file or directory on the local filesystem. */
export async function localDelete(path: string, isDirectory: boolean): Promise<void> {
  await invoke("local_delete", { path, isDirectory });
}

/** Rename a file or directory on the local filesystem. */
export async function localRename(oldPath: string, newPath: string): Promise<void> {
  await invoke("local_rename", { oldPath, newPath });
}

/** Read a local file's contents as a UTF-8 string. */
export async function localReadFile(path: string): Promise<string> {
  return await invoke<string>("local_read_file", { path });
}

/** Write a string to a local file. */
export async function localWriteFile(path: string, content: string): Promise<void> {
  await invoke("local_write_file", { path, content });
}

/**
 * Start watching a local file for external on-disk changes (#1620).
 *
 * `watchId` is an opaque per-editor-instance key; the resulting
 * `local-file-changed` events carry it back so the right editor reloads.
 * Re-watching the same id replaces the previous watch.
 */
export async function watchLocalFile(watchId: string, path: string): Promise<void> {
  await invoke("watch_local_file", { watchId, path });
}

/** Stop watching a local file previously registered with {@link watchLocalFile}. */
export async function unwatchLocalFile(watchId: string): Promise<void> {
  await invoke("unwatch_local_file", { watchId });
}

/**
 * Start watching a local directory for external on-disk changes (#1626).
 *
 * `watchId` is an opaque per-browser-instance key; the resulting
 * `local-dir-changed` events carry it back so the right file browser refreshes.
 * Re-watching the same id replaces the previous watch (used to re-target when
 * the browsed directory changes).
 */
export async function watchLocalDir(watchId: string, path: string): Promise<void> {
  await invoke("watch_local_dir", { watchId, path });
}

/** Stop watching a local directory previously registered with {@link watchLocalDir}. */
export async function unwatchLocalDir(watchId: string): Promise<void> {
  await invoke("unwatch_local_dir", { watchId });
}

/** Read a remote file's contents as a UTF-8 string via SFTP. */
export async function sftpReadFileContent(sessionId: string, remotePath: string): Promise<string> {
  return await invoke<string>("sftp_read_file_content", { sessionId, remotePath });
}

/** Write a string to a remote file via SFTP. */
export async function sftpWriteFileContent(
  sessionId: string,
  remotePath: string,
  content: string
): Promise<void> {
  await invoke("sftp_write_file_content", { sessionId, remotePath, content });
}

/**
 * Outcome of a privilege-elevated (`sudo`) remote write.
 *
 * - `success` — the destination was rewritten with root privileges.
 * - `incorrectPassword` — the sudo password was rejected; safe to re-prompt.
 * - `other` — any other failure (sudo missing, not in sudoers, requiretty, a
 *   write error), with a `message` suitable for display.
 */
export type ElevatedWriteResult =
  | { kind: "success" }
  | { kind: "incorrectPassword" }
  | { kind: "other"; message: string };

/**
 * Write a string to a remote file with `sudo`-elevated privileges.
 *
 * Uploads the buffer to a temp path via SFTP, then rewrites the destination in
 * place via `sudo -S` over the SSH exec channel (password on stdin). Returns a
 * typed {@link ElevatedWriteResult} rather than throwing on an authorization
 * failure, so the caller can re-prompt on `incorrectPassword`. The temp file is
 * always cleaned up and the password is never logged on the backend.
 */
export async function sftpWriteFileContentElevated(
  sessionId: string,
  remotePath: string,
  content: string,
  sudoPassword: string
): Promise<ElevatedWriteResult> {
  return await invoke<ElevatedWriteResult>("sftp_write_file_content_elevated", {
    sessionId,
    remotePath,
    content,
    sudoPassword,
  });
}

/**
 * Report whether the SFTP session's SSH connection can open an exec channel
 * (i.e. run remote commands such as `sudo`).
 *
 * Returns `true` for a normal SSH+shell connection and `false` for an
 * SFTP-only or relayed connection. Lets the editor know whether
 * privilege-elevated writes are possible.
 */
export async function sftpHasExecCapability(sessionId: string): Promise<boolean> {
  return await invoke<boolean>("sftp_has_exec_capability", { sessionId });
}

/**
 * Probe whether the connecting user can actually open a specific remote file
 * for writing, via a non-destructive SFTP write-open probe (issue #1324).
 *
 * Returns `"writable"` / `"readOnly"` / `"unknown"`; the probe never modifies
 * the file. `"unknown"` means the check was inconclusive — the caller treats it
 * as writable and attempts the save so a false negative never blocks editing.
 * This catches the owner-mismatch case the cheap `FileEntry.writable` hint
 * cannot detect.
 */
export async function sftpCheckWritable(
  sessionId: string,
  remotePath: string
): Promise<Writability> {
  return await invoke<Writability>("sftp_check_writable", { sessionId, remotePath });
}

// --- Session-based file browsing commands ---
// These work with any connection type that has file browser capability
// (including remote agent sessions) by using the terminal session ID directly.

/** List directory contents via a session's file browser capability. */
export async function sessionListFiles(sessionId: string, path: string): Promise<FileEntry[]> {
  return await invoke<FileEntry[]>("session_list_files", { sessionId, path });
}

/** Read a file via a session's file browser capability. Returns raw bytes. */
export async function sessionReadFile(sessionId: string, path: string): Promise<number[]> {
  return await invoke<number[]>("session_read_file", { sessionId, path });
}

/**
 * Get metadata for a single file via a session's file browser capability.
 *
 * Backs the editor's remote external-change detection (#1627): the frontend
 * re-stats the open file on an interval and compares `modified`/`size`.
 */
export async function sessionStat(sessionId: string, path: string): Promise<FileEntry> {
  return await invoke<FileEntry>("session_stat", { sessionId, path });
}

/** Write raw bytes to a file via a session's file browser capability. */
export async function sessionWriteFile(
  sessionId: string,
  path: string,
  data: number[]
): Promise<void> {
  await invoke("session_write_file", { sessionId, path, data });
}

/** Delete a file or directory via a session's file browser capability. */
export async function sessionDeleteFile(sessionId: string, path: string): Promise<void> {
  await invoke("session_delete_file", { sessionId, path });
}

/** Rename a file or directory via a session's file browser capability. */
export async function sessionRenameFile(
  sessionId: string,
  oldPath: string,
  newPath: string
): Promise<void> {
  await invoke("session_rename_file", { sessionId, oldPath, newPath });
}

/** Create a directory via a session's file browser capability. */
export async function sessionMkdir(sessionId: string, path: string): Promise<void> {
  await invoke("session_mkdir", { sessionId, path });
}

// --- VS Code integration ---

/** Check if VS Code CLI (`code`) is available on PATH. */
export async function vscodeAvailable(): Promise<boolean> {
  return await invoke<boolean>("vscode_available");
}

/** Open a local file in VS Code (fire-and-forget). */
export async function vscodeOpenLocal(path: string): Promise<void> {
  await invoke("vscode_open_local", { path });
}

/** Open a remote file in VS Code: download, edit, re-upload. */
export async function vscodeOpenRemote(sessionId: string, remotePath: string): Promise<void> {
  await invoke("vscode_open_remote", { sessionId, remotePath });
}

// --- Agent commands ---

/** Info about a remote session on an agent. */
export interface AgentSessionInfo {
  sessionId: string;
  title: string;
  type: string;
  status: string;
  attached: boolean;
  /**
   * ID of the saved connection definition this session was created from,
   * when known. Lets the UI re-link an active session to its source
   * definition (e.g. to derive the persistent connectionId for reattach
   * via the existing scrollback-replay path).
   */
  definitionId?: string;
}

/** Info about a saved connection definition on an agent. */
export interface AgentDefinitionInfo {
  id: string;
  name: string;
  sessionType: string;
  config: Record<string, unknown>;
  persistent: boolean;
  folderId: string | null;
  terminalOptions?: TerminalOptions;
  icon?: string;
  /** Source file path on the remote host, or undefined for the primary store. */
  sourceFile?: string;
}

/** Info about a folder on an agent. */
export interface AgentFolderInfo {
  id: string;
  name: string;
  parentId: string | null;
  isExpanded: boolean;
}

/** Combined connections and folders from an agent. */
export interface AgentConnectionsData {
  connections: AgentDefinitionInfo[];
  folders: AgentFolderInfo[];
}

/** Result of connecting to an agent. */
interface AgentConnectResult {
  capabilities: AgentCapabilities;
  agentVersion: string;
  protocolVersion: string;
}

/** Connect to a remote agent via SSH. Returns capabilities. */
export async function connectAgent(
  agentId: string,
  config: RemoteAgentConfig,
  agentSettings?: AgentSettings
): Promise<AgentConnectResult> {
  return await invoke<AgentConnectResult>("connect_agent", {
    agentId,
    config,
    agentSettings: agentSettings ?? null,
  });
}

/** Push updated AgentSettings to a running agent and persist locally. */
export async function applyAgentSettings(agentId: string, settings: AgentSettings): Promise<void> {
  await invoke("apply_agent_settings", { agentId, settings });
}

/** Outcome of a deferred agent-update request (#1352). */
export interface AgentDeferredUpdateResult {
  /**
   * `true` when the agent was idle and applied the update immediately (the
   * connection is expected to drop as the binary swaps); `false` when the
   * update was deferred until the last of `activeSessions` disconnects.
   */
  applied: boolean;
  /** Number of active sessions the update will wait on when `applied` is false. */
  activeSessions: number;
}

/**
 * Request a deferred agent update. Omit `binaryPath` to apply the agent's
 * already-staged pending update (the banner case). When the agent is idle it
 * applies immediately (`applied: true`); otherwise it defers until the last of
 * `activeSessions` sessions disconnects (`applied: false`).
 */
export async function requestAgentDeferredUpdate(
  agentId: string,
  binaryPath?: string,
  version?: string
): Promise<AgentDeferredUpdateResult> {
  return await invoke<AgentDeferredUpdateResult>("request_agent_deferred_update", {
    agentId,
    binaryPath,
    version,
  });
}

/** Outcome of a coordinated agent-update request (#1602 / #1351, SI-5). */
export interface AgentCoordinatedUpdateResult {
  /**
   * `true` when the agent was idle and applied the update immediately (the
   * connection is expected to drop as the binary swaps); `false` when the update
   * was deferred until the last of `activeSessions` disconnects.
   */
  applied: boolean;
  /** Number of active sessions the update will wait on when `applied` is false. */
  activeSessions: number;
  /** How many *other* connected hosts were sent the `agent.update_pending` notice. */
  notifiedClients: number;
  /**
   * `true` when every notified host disconnected inside the window (or there was
   * nobody to notify); `false` when the window closed with hosts still attached.
   */
  allAcked: boolean;
  /** Hosts still attached when the coordination window closed. Empty on success. */
  remainingClients: string[];
}

/**
 * Request a coordinated agent update (#1602 / #1351, SI-5). The agent broadcasts
 * an `agent.update_pending` notice to every *other* connected host, gives them a
 * window to disconnect cleanly, then applies through the deferred-apply path —
 * never interrupting active sessions. Omit `binaryPath` to apply the agent's
 * already-staged pending update (the coordinated "Apply Now" path).
 */
export async function requestAgentUpdate(
  agentId: string,
  binaryPath?: string,
  version?: string
): Promise<AgentCoordinatedUpdateResult> {
  return await invoke<AgentCoordinatedUpdateResult>("request_agent_update", {
    agentId,
    binaryPath,
    version,
  });
}

/** Disconnect from a remote agent. */
export async function disconnectAgent(agentId: string): Promise<void> {
  await invoke("disconnect_agent", { agentId });
}

/**
 * Sweep every agent whose backend I/O task has already died (`alive=false`).
 *
 * Manual resource-hygiene escape hatch for the Open Connections panel. Returns
 * the ids that were pruned.
 */
export async function pruneDeadAgents(): Promise<string[]> {
  return await invoke<string[]>("prune_dead_agents");
}

/**
 * Cancel an in-flight (still connecting) agent connect. Aborts the blocking
 * SSH + initialize handshake promptly instead of waiting out the connect
 * timeout; the backend then emits `disconnected` (single writer). No-op if the
 * connect already finished. Returns whether a connecting agent was found (G1,
 * #1235).
 */
export async function cancelConnectAgent(agentId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_connect_agent", { agentId });
}

/** Gracefully shut down a remote agent and disconnect. Returns detached session count. */
export async function shutdownAgent(agentId: string, reason?: string): Promise<number> {
  return await invoke<number>("shutdown_agent", { agentId, reason: reason ?? null });
}

/** Get capabilities of a connected agent. */
export async function getAgentCapabilities(agentId: string): Promise<AgentCapabilities> {
  return await invoke<AgentCapabilities>("get_agent_capabilities", { agentId });
}

/** List active sessions on an agent. */
export async function listAgentSessions(agentId: string): Promise<AgentSessionInfo[]> {
  return await invoke<AgentSessionInfo[]>("list_agent_sessions", { agentId });
}

/** Close a specific session on a remote agent (frees serial port, SSH channel, etc.). */
export async function closeAgentSession(agentId: string, sessionId: string): Promise<void> {
  await invoke("close_agent_session", { agentId, sessionId });
}

/** List saved session definitions on an agent. */
export async function listAgentDefinitions(agentId: string): Promise<AgentDefinitionInfo[]> {
  return await invoke<AgentDefinitionInfo[]>("list_agent_definitions", { agentId });
}

/** Save a session definition on an agent. */
export async function saveAgentDefinition(
  agentId: string,
  definition: Record<string, unknown>
): Promise<AgentDefinitionInfo> {
  return await invoke<AgentDefinitionInfo>("save_agent_definition", { agentId, definition });
}

/** Delete a session definition on an agent. */
export async function deleteAgentDefinition(agentId: string, definitionId: string): Promise<void> {
  await invoke("delete_agent_definition", { agentId, definitionId });
}

/** List saved connections and folders on an agent. */
export async function listAgentConnections(agentId: string): Promise<AgentConnectionsData> {
  return await invoke<AgentConnectionsData>("list_agent_connections", { agentId });
}

/** Update a saved connection definition on an agent. */
export async function updateAgentDefinition(
  agentId: string,
  params: Record<string, unknown>
): Promise<AgentDefinitionInfo> {
  return await invoke<AgentDefinitionInfo>("update_agent_definition", { agentId, params });
}

/** Create a folder on an agent. */
export async function createAgentFolder(
  agentId: string,
  name: string,
  parentId?: string | null
): Promise<AgentFolderInfo> {
  return await invoke<AgentFolderInfo>("create_agent_folder", {
    agentId,
    name,
    parentId: parentId ?? null,
  });
}

/** Update a folder on an agent. */
export async function updateAgentFolder(
  agentId: string,
  params: Record<string, unknown>
): Promise<AgentFolderInfo> {
  return await invoke<AgentFolderInfo>("update_agent_folder", { agentId, params });
}

/** Delete a folder on an agent. */
export async function deleteAgentFolder(agentId: string, folderId: string): Promise<void> {
  await invoke("delete_agent_folder", { agentId, folderId });
}

// --- Agent setup commands ---

/** Source for the agent binary during setup. */
export type AgentBinarySource =
  | { type: "githubDownload" }
  | { type: "branchBuild"; branch: string }
  | { type: "localFile"; path: string };

/** Configuration for setting up a remote agent. */
export interface AgentSetupConfig {
  binarySource: AgentBinarySource;
  /** Raw `uname -s` output detected before the dialog opened (e.g. `"Linux"`, `"Darwin"`). */
  remoteOs: string;
  /** Raw `uname -m` output detected before the dialog opened. */
  remoteArch: string;
  remotePath?: string;
  installService: boolean;
}

/** Remote host architecture info, returned before the setup dialog opens. */
export interface RemoteArchInfo {
  /** Raw `uname -m` output, e.g. `"aarch64"`. */
  arch: string;
  /** Raw `uname -s` output, e.g. `"Linux"`. */
  os: string;
  /** Artifact suffix for binary filenames, e.g. `"linux-arm64"`. Null if unsupported. */
  archSuffix: string | null;
  /** Base download URL without the arch suffix (ends with `"termihub-agent-"`).
   *  Append any supported arch suffix to build the full URL for that arch. */
  downloadBaseUrl: string;
  /** Pre-computed GitHub download URL for the detected arch. Null if arch is unsupported. */
  downloadUrl: string | null;
  /** The git branch this desktop app was built from, if it is a feature-branch build.
   *  Null for main/develop/release builds. Used to pre-fill the branch build option. */
  buildBranch: string | null;
}

/** Result of initiating the agent setup flow. */
export interface AgentSetupResult {
  sessionId: string;
}

/**
 * Detect the remote host's architecture before opening the setup dialog.
 * Establishes a temporary SSH connection and runs `uname -m` / `uname -s`.
 */
export async function detectAgentArch(config: RemoteAgentConfig): Promise<RemoteArchInfo> {
  return await invoke<RemoteArchInfo>("detect_agent_arch", { config });
}

/** Upload and install the remote agent binary on a host. */
export async function setupRemoteAgent(
  agentId: string,
  config: RemoteAgentConfig,
  setupConfig: AgentSetupConfig
): Promise<AgentSetupResult> {
  return await invoke<AgentSetupResult>("setup_remote_agent", {
    agentId,
    config,
    setupConfig,
  });
}

/**
 * Cancel an in-flight agent deploy/setup, aborting the background SFTP upload /
 * script injection between steps and rolling back the partial upload (#1242).
 * No-op if no run is in flight. Returns whether a run was found.
 */
export async function cancelAgentSetup(agentId: string): Promise<boolean> {
  return await invoke<boolean>("cancel_agent_setup", { agentId });
}

// --- Agent deployment commands ---

/** Result of probing a remote host for the agent binary. */
export interface AgentProbeResult {
  found: boolean;
  version: string | null;
  remoteArch: string;
  remoteOs: string;
  compatible: boolean;
}

/** Configuration for deploying the agent to a remote host. */
export interface AgentDeployConfig {
  remotePath?: string;
}

/** A host (other than this desktop) connected to the agent when an update is
 * requested. Surfaced in the Update dialog's connected-host warning (#1349). */
export interface ConnectedHost {
  /** Agent-assigned id for this client connection. */
  clientId: string;
  /** Client name reported in `initialize` (e.g. `"termihub-desktop"`). */
  client: string;
  /** Client version reported in `initialize`. */
  clientVersion: string;
  /** ISO 8601 timestamp of when the host connected to the agent. */
  connectedSince: string;
}

/**
 * Result of deploying or updating the agent on a remote host.
 *
 * Discriminated on `kind`:
 * - `deployed` — the normal outcome of a deploy or immediate update.
 * - `otherHostsConnected` — the connected-host guard blocked an unforced
 *   immediate update because other hosts are attached; the desktop shows the
 *   warning and may retry via {@link updateAgentForce}.
 * - `coordinated` — a coordinated-strategy update (#1616) was dispatched on a
 *   Unix host: the binary was staged and handed to `agent.request_update`, which
 *   notified every other connected host and let the agent self-apply. Windows
 *   coordinated updates fall back to the immediate path and return `deployed`.
 */
export type AgentDeployResult =
  | {
      kind: "deployed";
      success: boolean;
      installedVersion: string | null;
      /**
       * Absolute path the agent was installed to on the remote host. On Windows
       * this is the resolved `%LOCALAPPDATA%\termiHub\agent\termihub-agent.exe`
       * location, which differs from the POSIX default. May be omitted.
       */
      installedPath?: string | null;
    }
  | {
      kind: "otherHostsConnected";
      hosts: ConnectedHost[];
    }
  | {
      kind: "coordinated";
      /**
       * `true` when the agent was idle and applied immediately (the connection
       * is expected to drop as the binary swaps); `false` when deferred until the
       * last of `activeSessions` disconnects.
       */
      applied: boolean;
      /** Sessions the update will wait on when `applied` is false. */
      activeSessions: number;
      /** How many *other* connected hosts were sent the `update_pending` notice. */
      notifiedClients: number;
      /** `true` when every notified host disconnected inside the window. */
      allAcked: boolean;
      /** Hosts still attached when the coordination window closed. */
      remainingClients: string[];
    };

/** Probe a remote host for an existing agent binary. */
export async function probeRemoteAgent(
  config: RemoteAgentConfig,
  expectedVersion?: string
): Promise<AgentProbeResult> {
  return await invoke<AgentProbeResult>("probe_remote_agent", {
    config,
    expectedVersion: expectedVersion ?? null,
  });
}

/** Deploy the agent binary to a remote host via SFTP. */
export async function deployAgent(
  agentId: string,
  config: RemoteAgentConfig,
  deployConfig: AgentDeployConfig
): Promise<AgentDeployResult> {
  return await invoke<AgentDeployResult>("deploy_agent", { agentId, config, deployConfig });
}

/**
 * Update the agent: shut down the running instance, then deploy a new binary.
 *
 * Runs the connected-host guard first: if other hosts are connected, resolves
 * to `{ kind: "otherHostsConnected", hosts }` without touching the remote, so
 * the caller can warn the user and retry via {@link updateAgentForce}.
 */
export async function updateAgent(
  agentId: string,
  config: RemoteAgentConfig,
  deployConfig: AgentDeployConfig
): Promise<AgentDeployResult> {
  return await invoke<AgentDeployResult>("update_agent", { agentId, config, deployConfig });
}

/**
 * Force an agent update, bypassing the connected-host guard. Call after the
 * user confirms in the Update dialog that other connected hosts may be
 * hard-cut (#1349).
 */
export async function updateAgentForce(
  agentId: string,
  config: RemoteAgentConfig,
  deployConfig: AgentDeployConfig
): Promise<AgentDeployResult> {
  return await invoke<AgentDeployResult>("update_agent_force", { agentId, config, deployConfig });
}

// --- Agent persistence commands ---

/** Save (add or update) a remote agent definition to disk. */
export async function saveRemoteAgent(agent: SavedRemoteAgent): Promise<void> {
  await invoke("save_remote_agent", { agent });
}

/** Delete a remote agent definition from disk. */
export async function deleteRemoteAgentFromBackend(id: string): Promise<void> {
  await invoke("delete_remote_agent", { id });
}

/** Reorder remote agents by providing agent IDs in the desired order. */
export async function reorderRemoteAgents(agentIds: string[]): Promise<void> {
  await invoke("reorder_remote_agents", { agentIds });
}

// --- Session-based monitoring commands ---

/** Return the capabilities of an active session. */
export async function sessionGetCapabilities(
  sessionId: string
): Promise<{ monitoring: boolean; fileBrowser: boolean }> {
  return await invoke<{ monitoring: boolean; fileBrowser: boolean }>("session_get_capabilities", {
    sessionId,
  });
}

/**
 * Start session-based monitoring; stats arrive as `session-monitoring-stats` Tauri events.
 *
 * `intervalMs` sets the collection cadence; when omitted the backend default is used (#1233).
 */
export async function sessionMonitoringOpen(sessionId: string, intervalMs?: number): Promise<void> {
  await invoke("session_monitoring_open", { sessionId, intervalMs });
}

/** Stop session-based monitoring. */
export async function sessionMonitoringClose(sessionId: string): Promise<void> {
  await invoke("session_monitoring_close", { sessionId });
}

/** Pause or resume a session monitor's collection loop (#1233). */
export async function sessionMonitoringSetPaused(
  sessionId: string,
  paused: boolean
): Promise<void> {
  await invoke("session_monitoring_set_paused", { sessionId, paused });
}

/** Change a session monitor's refresh interval in milliseconds (#1233). */
export async function sessionMonitoringSetInterval(
  sessionId: string,
  intervalMs: number
): Promise<void> {
  await invoke("session_monitoring_set_interval", { sessionId, intervalMs });
}

/** Cancel a session monitor's in-flight connect / collect (#1233). */
export async function sessionMonitoringCancel(sessionId: string): Promise<void> {
  await invoke("session_monitoring_cancel", { sessionId });
}

// --- Log commands ---

/** Retrieve the most recent log entries from the backend ring buffer. */
export async function getLogs(count: number): Promise<LogEntry[]> {
  return await invoke<LogEntry[]>("get_logs", { count });
}

/** Clear all buffered log entries in the backend. */
export async function clearLogs(): Promise<void> {
  await invoke("clear_logs");
}

// --- Credential store commands ---

/** Get the current credential store status. */
export async function getCredentialStoreStatus(): Promise<CredentialStoreStatusInfo> {
  return await invoke<CredentialStoreStatusInfo>("get_credential_store_status");
}

/**
 * Error thrown by {@link unlockCredentialStore} when unlock fails.
 *
 * `corrupted` is `true` when the credentials file is unreadable/corrupt (G8,
 * #1144), so the UI can offer a "reset store" recovery instead of an endless
 * wrong-password loop.
 */
export interface UnlockCredentialStoreError {
  message: string;
  corrupted: boolean;
}

/** Unlock the master password credential store. */
export async function unlockCredentialStore(password: string): Promise<void> {
  await invoke("unlock_credential_store", { password });
}

/**
 * Reset (delete) a corrupt master password credential store so it can be set up
 * again. Used to recover from an unreadable credentials file (G8, #1144).
 */
export async function resetCredentialStore(): Promise<void> {
  await invoke("reset_credential_store");
}

/** Lock the master password credential store. */
export async function lockCredentialStore(): Promise<void> {
  await invoke("lock_credential_store");
}

/** Set up a new master password for the credential store. */
export async function setupMasterPassword(password: string): Promise<void> {
  await invoke("setup_master_password", { password });
}

/** Change the master password for the credential store. */
export async function changeMasterPassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  await invoke("change_master_password", { currentPassword, newPassword });
}

/** Switch the credential storage backend. Optionally migrates existing credentials. */
export async function switchCredentialStore(
  newMode: string,
  masterPassword?: string
): Promise<SwitchCredentialStoreResult> {
  return await invoke<SwitchCredentialStoreResult>("switch_credential_store", {
    newMode,
    masterPassword: masterPassword ?? null,
  });
}

/** Update the auto-lock timeout for the master password credential store. */
export async function setAutoLockTimeout(minutes: number | null): Promise<void> {
  await invoke("set_auto_lock_timeout", { minutes });
}

/**
 * A credential kind the frontend can store/resolve/remove. Mirrors the backend
 * `CredentialType` string forms. `sudo_password` (#1327) backs the elevated
 * edit mode's opt-in persistence (#1329).
 */
export type CredentialType = "password" | "key_passphrase" | "sudo_password";

/** Store a credential for a connection (e.g., after entering it via the password prompt). */
export async function storeCredential(
  connectionId: string,
  credentialType: CredentialType,
  value: string
): Promise<void> {
  await invoke("store_credential", { connectionId, credentialType, value });
}

/** Resolve a stored credential for a connection. Returns the value or null if not found. */
export async function resolveCredential(
  connectionId: string,
  credentialType: CredentialType
): Promise<string | null> {
  return await invoke<string | null>("resolve_credential", { connectionId, credentialType });
}

/** Remove a stored credential for a connection (e.g., after auth failure). */
export async function removeCredential(
  connectionId: string,
  credentialType: CredentialType
): Promise<void> {
  await invoke("remove_credential", { connectionId, credentialType });
}

// --- Portable mode commands ---

/** Return the current app mode (portable vs. installed) and the data directory path. */
export async function getAppMode(): Promise<AppModeInfo> {
  return await invoke<AppModeInfo>("get_app_mode");
}

/** List config files present in a given directory. */
export async function listConfigFiles(dir: string): Promise<ConfigFileStatus[]> {
  return await invoke<ConfigFileStatus[]>("list_config_files", { dir });
}

/** Resolve a `{PORTABLE_DIR}` placeholder in a path string. */
export async function resolvePortablePath(path: string): Promise<string> {
  return await invoke<string>("resolve_portable_path_cmd", { path });
}

/**
 * Export the currently active config files to a portable data directory.
 *
 * @param destDir - Destination directory (the portable `data/` folder).
 * @param files - List of file names to copy (e.g. `["connections.json", "settings.json"]`).
 */
export async function exportConfigToPortable(
  destDir: string,
  files: string[]
): Promise<ConfigMigrationResult> {
  return await invoke<ConfigMigrationResult>("export_config_to_portable", { destDir, files });
}

/**
 * Import config files from a portable data directory into the current config directory.
 *
 * @param srcDir - Source directory (the portable `data/` folder).
 * @param files - List of file names to copy (e.g. `["connections.json", "settings.json"]`).
 */
export async function importConfigFromPortable(
  srcDir: string,
  files: string[]
): Promise<ConfigMigrationResult> {
  return await invoke<ConfigMigrationResult>("import_config_from_portable", { srcDir, files });
}

// ─── App info ──────────────────────────────────────────────────────────────

export interface AppInfo {
  /** Running version string, including `-dev` suffix for dev builds. */
  version: string;
  /** Short git commit hash embedded at build time. */
  gitHash: string;
  /** Whether this is a development (non-production) build. */
  isDev: boolean;
  /** Git branch this binary was built from (e.g. `"main"`, `"develop"`, `"unknown"`). */
  buildBranch: string;
}

/** Return build-time info: version (with `-dev` suffix in dev builds), git hash, and dev flag. */
export async function getAppInfo(): Promise<AppInfo> {
  return await invoke<AppInfo>("get_app_info");
}

// ─── Update checker ────────────────────────────────────────────────────────

/** Check GitHub for a newer termiHub release. Pass `force: true` to bypass the 1-hour rate limit. */
export async function checkForUpdates(force: boolean): Promise<UpdateInfo> {
  return await invoke<UpdateInfo>("check_for_updates", { force });
}

/** Persist the user's choice to skip a specific release version. */
export async function skipUpdateVersion(version: string): Promise<void> {
  await invoke("skip_update_version", { version });
}

/** Clear any previously skipped version so the user is reminded again. */
export async function clearSkippedVersion(): Promise<void> {
  await invoke("clear_skipped_version");
}

/** Persist the auto-check preference. */
export async function setUpdateAutoCheck(enabled: boolean): Promise<void> {
  await invoke("set_update_auto_check", { enabled });
}

/** Return current update settings (auto-check flag, last check time, skipped version). */
export async function getUpdateSettings(): Promise<UpdateSettings> {
  return await invoke<UpdateSettings>("get_update_settings");
}
