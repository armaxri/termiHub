/**
 * Tauri event listener setup.
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { LogEntry } from "@/types/terminal";
import { TunnelState, TunnelStats } from "@/types/tunnel";
import { CredentialStoreStatusInfo } from "@/types/credential";
import { ServerState } from "@/types/embeddedServer";
import { XServerConsentRequest, XServerProgress } from "@/types/xserver";
import { SshHostKeyPromptPayload } from "@/types/sshHostKey";
import type { TransferProgress } from "@/services/api";
import type {
  RemoteDesktopFramePayload,
  RemoteDesktopCursorPayload,
  RemoteDesktopClipboardPayload,
  RemoteDesktopStatePayload,
  RemoteDesktopCertPromptPayload,
} from "@/types/remoteDesktop";

interface TerminalOutputPayload {
  session_id: string;
  /**
   * Terminal output bytes as a base64 (standard alphabet, padded) string.
   *
   * Terminal output is the app's most important hot path. The backend encodes
   * the raw `Vec<u8>` as base64 (see `TerminalOutputEvent` in
   * `src-tauri/src/session/manager.rs`) instead of serde's default JSON
   * number-array — that was a 3.3–4x byte bloat plus a per-byte copy on every
   * flush. Decode with {@link base64ToBytes}, which is the exact inverse of the
   * Rust encoder for all byte values including high bytes and empty input
   * (#2072).
   */
  data: string;
}

/**
 * Decode a base64 (standard alphabet, padded) string into a `Uint8Array`.
 *
 * Exact inverse of the backend's base64 encoding of terminal-output bytes
 * (`serialize_bytes_base64` in `src-tauri/src/session/manager.rs`). Byte-for-byte
 * faithful for all values 0x00–0xFF (high bytes and UTF-8 multi-byte sequences
 * survive intact); an empty string decodes to a zero-length array (#2072).
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface TerminalExitPayload {
  session_id: string;
  exit_code: number | null;
}

interface RemoteStateChangePayload {
  session_id: string;
  state: string;
}

interface AgentStateChangePayload {
  session_id: string;
  state: string;
}

/** Subscribe to terminal output events */
export async function onTerminalOutput(
  callback: (sessionId: string, data: Uint8Array) => void
): Promise<UnlistenFn> {
  return await listen<TerminalOutputPayload>("terminal-output", (event) => {
    const { session_id, data } = event.payload;
    callback(session_id, base64ToBytes(data));
  });
}

/**
 * Subscribe to remote-desktop frame events (#1680). Fires for every session;
 * the caller filters by `payload.session_id`.
 */
export async function onRemoteDesktopFrame(
  callback: (payload: RemoteDesktopFramePayload) => void
): Promise<UnlistenFn> {
  return await listen<RemoteDesktopFramePayload>("remote-desktop-frame", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to remote-desktop cursor events. */
export async function onRemoteDesktopCursor(
  callback: (payload: RemoteDesktopCursorPayload) => void
): Promise<UnlistenFn> {
  return await listen<RemoteDesktopCursorPayload>("remote-desktop-cursor", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to remote-desktop clipboard events (remote → local text). */
export async function onRemoteDesktopClipboard(
  callback: (payload: RemoteDesktopClipboardPayload) => void
): Promise<UnlistenFn> {
  return await listen<RemoteDesktopClipboardPayload>("remote-desktop-clipboard", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to remote-desktop lifecycle state events. */
export async function onRemoteDesktopState(
  callback: (payload: RemoteDesktopStatePayload) => void
): Promise<UnlistenFn> {
  return await listen<RemoteDesktopStatePayload>("remote-desktop-state", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to interactive server-certificate trust prompts (#1767). Fires when
 * an RDP host presents an untrusted (unknown or changed) certificate; the caller
 * filters by `payload.session_id` and shows the accept/reject dialog.
 */
export async function onRemoteDesktopCertPrompt(
  callback: (payload: RemoteDesktopCertPromptPayload) => void
): Promise<UnlistenFn> {
  return await listen<RemoteDesktopCertPromptPayload>("remote-desktop-cert-prompt", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to interactive SSH host-key trust prompts (#1959). Fires when an SSH
 * server presents an untrusted (unknown or changed) host key; the global
 * `SshHostKeyPrompt` dialog shows the SHA-256 fingerprint and routes the verdict
 * back via `sshHostKeyDecision`.
 */
export async function onSshHostKeyPrompt(
  callback: (payload: SshHostKeyPromptPayload) => void
): Promise<UnlistenFn> {
  return await listen<SshHostKeyPromptPayload>("ssh-host-key-prompt", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to terminal exit events */
export async function onTerminalExit(
  callback: (sessionId: string, exitCode: number | null) => void
): Promise<UnlistenFn> {
  return await listen<TerminalExitPayload>("terminal-exit", (event) => {
    const { session_id, exit_code } = event.payload;
    callback(session_id, exit_code);
  });
}

/**
 * Listen for backend `session → window` ownership changes (#1985): a window
 * claimed or released a session, or a window was destroyed and its sessions
 * released. Fires with no payload — the listener refetches the ownership map so
 * a non-owning window learns of a sibling's claim immediately (push), rather
 * than only once a `transfer-progress` event happens to flow.
 */
export async function onSessionOwnershipChanged(callback: () => void): Promise<UnlistenFn> {
  return await listen("session-ownership-changed", () => callback());
}

/**
 * Singleton dispatcher that registers one global Tauri listener for each
 * terminal event type and routes events to per-session callbacks via Map
 * lookup. This replaces the O(N) fan-out pattern where each Terminal
 * component registered its own global listener.
 *
 * Multiple subscribers per session are supported (needed for persistent
 * sessions where several tabs can attach to the same backend process).
 */
export class TerminalOutputDispatcher {
  private outputCallbacks = new Map<string, Set<(data: Uint8Array) => void>>();
  private exitCallbacks = new Map<string, Set<(exitCode: number | null) => void>>();
  private remoteStateCallbacks = new Map<string, (state: string) => void>();
  private agentStateCallbacks = new Map<string, (state: string) => void>();
  /** Buffer output for sessions whose subscriber hasn't registered yet. */
  private pendingOutput = new Map<string, Uint8Array[]>();
  /**
   * Per-session cap on pre-subscribe buffered output (bytes). A session that
   * emits a lot of output before (or without) a subscriber registering would
   * otherwise grow its buffer without bound; past this ceiling the oldest chunks
   * are dropped so long-lived sessions cannot leak memory here (#2073).
   */
  private static readonly MAX_PENDING_OUTPUT_BYTES = 256 * 1024;
  /** Buffer exit events for sessions whose subscriber hasn't registered yet. */
  private pendingExit = new Map<string, number | null>();
  private unlistenOutput: UnlistenFn | null = null;
  private unlistenExit: UnlistenFn | null = null;
  private unlistenRemoteState: UnlistenFn | null = null;
  private unlistenAgentState: UnlistenFn | null = null;
  private initPromise: Promise<void> | null = null;
  private initGeneration = 0;

  /**
   * Register global Tauri event listeners. Safe to call from multiple sites —
   * the first call triggers initialization and subsequent calls return the
   * same promise, guaranteeing listeners are registered before resolving.
   *
   * Uses a generation counter to handle the async race condition caused by
   * React StrictMode's mount → unmount → remount cycle: if destroy() is called
   * while the async listen() calls are still pending, the resolved listeners
   * are immediately unregistered instead of leaking as duplicates.
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const gen = this.initGeneration;

    const unlistenOutput = await listen<TerminalOutputPayload>("terminal-output", (event) => {
      const { session_id, data } = event.payload;
      const cbs = this.outputCallbacks.get(session_id);
      const chunk = base64ToBytes(data);
      if (cbs && cbs.size > 0) {
        for (const cb of cbs) cb(chunk);
      } else {
        // Buffer output for sessions whose subscriber hasn't registered yet
        // (e.g. pre-existing sessions created by agent setup).
        let buf = this.pendingOutput.get(session_id);
        if (!buf) {
          buf = [];
          this.pendingOutput.set(session_id, buf);
        }
        buf.push(chunk);
        this.trimPendingOutput(buf);
      }
    });

    if (gen !== this.initGeneration) {
      unlistenOutput();
      return;
    }
    this.unlistenOutput = unlistenOutput;

    const unlistenExit = await listen<TerminalExitPayload>("terminal-exit", (event) => {
      const { session_id, exit_code } = event.payload;
      // The session is gone: drop any pre-subscribe output still buffered for it.
      // A session that exits before (or without) a subscriber ever attaching would
      // otherwise keep its buffered output alive forever (#2073). The scrollback a
      // reattaching tab needs is restored from the backend's cached buffer, not
      // from this live-tail buffer, so dropping it here loses nothing visible.
      this.pendingOutput.delete(session_id);
      const cbs = this.exitCallbacks.get(session_id);
      if (cbs && cbs.size > 0) {
        for (const cb of cbs) cb(exit_code);
      } else {
        // Buffer the exit for sessions whose subscriber hasn't registered yet
        // (e.g. race between session death and tab reattach setup).
        this.pendingExit.set(session_id, exit_code);
      }
    });

    if (gen !== this.initGeneration) {
      unlistenExit();
      this.unlistenOutput();
      this.unlistenOutput = null;
      return;
    }
    this.unlistenExit = unlistenExit;

    const unlistenRemoteState = await listen<RemoteStateChangePayload>(
      "remote-state-change",
      (event) => {
        const { session_id, state } = event.payload;
        const cb = this.remoteStateCallbacks.get(session_id);
        if (cb) {
          cb(state);
        }
      }
    );

    if (gen !== this.initGeneration) {
      unlistenRemoteState();
      this.unlistenOutput();
      this.unlistenOutput = null;
      this.unlistenExit();
      this.unlistenExit = null;
      return;
    }
    this.unlistenRemoteState = unlistenRemoteState;

    const unlistenAgentState = await listen<AgentStateChangePayload>(
      "agent-state-change",
      (event) => {
        const { session_id, state } = event.payload;
        const cb = this.agentStateCallbacks.get(session_id);
        if (cb) {
          cb(state);
        }
      }
    );

    if (gen !== this.initGeneration) {
      unlistenAgentState();
      this.unlistenOutput();
      this.unlistenOutput = null;
      this.unlistenExit();
      this.unlistenExit = null;
      this.unlistenRemoteState();
      this.unlistenRemoteState = null;
      return;
    }
    this.unlistenAgentState = unlistenAgentState;
  }

  /** Subscribe to output events for a specific session. Returns an unsubscribe function. */
  subscribeOutput(sessionId: string, callback: (data: Uint8Array) => void): () => void {
    let cbs = this.outputCallbacks.get(sessionId);
    if (!cbs) {
      cbs = new Set();
      this.outputCallbacks.set(sessionId, cbs);
    }
    cbs.add(callback);
    // Flush any output that arrived before the subscriber registered
    const buffered = this.pendingOutput.get(sessionId);
    if (buffered) {
      this.pendingOutput.delete(sessionId);
      for (const chunk of buffered) {
        callback(chunk);
      }
    }
    return () => {
      const set = this.outputCallbacks.get(sessionId);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.outputCallbacks.delete(sessionId);
      }
    };
  }

  /** Subscribe to exit events for a specific session. Returns an unsubscribe function. */
  subscribeExit(sessionId: string, callback: (exitCode: number | null) => void): () => void {
    let cbs = this.exitCallbacks.get(sessionId);
    if (!cbs) {
      cbs = new Set();
      this.exitCallbacks.set(sessionId, cbs);
    }
    cbs.add(callback);
    // Fire any exit that arrived before this subscriber registered
    if (this.pendingExit.has(sessionId)) {
      const exitCode = this.pendingExit.get(sessionId)!;
      this.pendingExit.delete(sessionId);
      callback(exitCode);
    }
    return () => {
      const set = this.exitCallbacks.get(sessionId);
      if (set) {
        set.delete(callback);
        if (set.size === 0) this.exitCallbacks.delete(sessionId);
      }
    };
  }

  /** Discard any buffered exit for a session (call at the start of a fresh reattach to clear stale exits). */
  clearPendingExit(sessionId: string): void {
    this.pendingExit.delete(sessionId);
  }

  /** Discard any buffered output for a session (call before writing cached buffer to avoid duplication). */
  clearPendingOutput(sessionId: string): void {
    this.pendingOutput.delete(sessionId);
  }

  /**
   * Bounds a session's pre-subscribe buffer to
   * {@link TerminalOutputDispatcher.MAX_PENDING_OUTPUT_BYTES}, dropping the
   * oldest chunks once the ceiling is exceeded. Always keeps at least the most
   * recent chunk, so a single oversized chunk is never discarded outright.
   */
  private trimPendingOutput(buf: Uint8Array[]): void {
    let total = 0;
    for (const chunk of buf) total += chunk.length;
    while (total > TerminalOutputDispatcher.MAX_PENDING_OUTPUT_BYTES && buf.length > 1) {
      total -= buf.shift()!.length;
    }
  }

  /** Subscribe to remote state change events for a specific session. Returns an unsubscribe function. */
  subscribeRemoteState(sessionId: string, callback: (state: string) => void): () => void {
    this.remoteStateCallbacks.set(sessionId, callback);
    return () => {
      this.remoteStateCallbacks.delete(sessionId);
    };
  }

  /** Subscribe to agent state change events for a specific agent. Returns an unsubscribe function. */
  subscribeAgentState(agentId: string, callback: (state: string) => void): () => void {
    this.agentStateCallbacks.set(agentId, callback);
    return () => {
      this.agentStateCallbacks.delete(agentId);
    };
  }

  /** Tear down global listeners and clear all callbacks. */
  destroy(): void {
    this.initGeneration++;
    if (this.unlistenOutput) {
      this.unlistenOutput();
      this.unlistenOutput = null;
    }
    if (this.unlistenExit) {
      this.unlistenExit();
      this.unlistenExit = null;
    }
    if (this.unlistenRemoteState) {
      this.unlistenRemoteState();
      this.unlistenRemoteState = null;
    }
    if (this.unlistenAgentState) {
      this.unlistenAgentState();
      this.unlistenAgentState = null;
    }
    this.outputCallbacks.clear();
    this.exitCallbacks.clear();
    this.remoteStateCallbacks.clear();
    this.agentStateCallbacks.clear();
    this.pendingOutput.clear();
    this.pendingExit.clear();
    this.initPromise = null;
  }
}

/** Singleton instance used by Terminal components. */
export const terminalDispatcher = new TerminalOutputDispatcher();

interface AgentSetupProgressPayload {
  agent_id: string;
  step: string;
  message: string;
}

/** Subscribe to agent setup progress events. */
export async function onAgentSetupProgress(
  callback: (agentId: string, step: string, message: string) => void
): Promise<UnlistenFn> {
  return await listen<AgentSetupProgressPayload>("agent-setup-progress", (event) => {
    callback(event.payload.agent_id, event.payload.step, event.payload.message);
  });
}

interface AgentDeployProgressPayload {
  agent_id: string;
  step: string;
  message: string;
  progress: number;
}

/** Subscribe to agent deploy progress events. */
export async function onAgentDeployProgress(
  callback: (agentId: string, step: string, message: string, progress: number) => void
): Promise<UnlistenFn> {
  return await listen<AgentDeployProgressPayload>("agent-deploy-progress", (event) => {
    callback(
      event.payload.agent_id,
      event.payload.step,
      event.payload.message,
      event.payload.progress
    );
  });
}

/**
 * Payload of an `agent-update-available` event (#1352). The desktop backend
 * forwards the agent's `agent.update_available` JSON-RPC notification, tagging
 * it with the originating `agent_id`. `staged: true` means a verified new binary
 * is staged on the agent and ready to apply (idle) or defer (busy).
 */
interface AgentUpdateAvailablePayload {
  agent_id: string;
  currentVersion: string;
  availableVersion: string;
  staged: boolean;
}

/** A staged/available agent update, keyed to its originating agent. */
export interface AgentUpdateAvailable {
  agentId: string;
  currentVersion: string;
  availableVersion: string;
  staged: boolean;
}

/**
 * Subscribe to `agent.update_available` notifications forwarded by the backend
 * as `agent-update-available` Tauri events (#1352). Returns the unlisten handle.
 */
export async function onAgentUpdateAvailable(
  callback: (update: AgentUpdateAvailable) => void
): Promise<UnlistenFn> {
  return await listen<AgentUpdateAvailablePayload>("agent-update-available", (event) => {
    callback({
      agentId: event.payload.agent_id,
      currentVersion: event.payload.currentVersion,
      availableVersion: event.payload.availableVersion,
      staged: event.payload.staged,
    });
  });
}

/**
 * Payload of a `remote-agent-update-pending` event (#1602). The desktop backend
 * forwards the agent's `agent.update_pending` JSON-RPC notification — broadcast
 * by the agent to every *other* connected host when one host initiates a
 * coordinated update (#1351) — tagged with the originating `agent_id`.
 */
interface RemoteAgentUpdatePendingPayload {
  agent_id: string;
  requestedByVersion: string;
  estimatedRestartSecs: number;
}

/**
 * A coordinated update in progress on an agent, initiated by another host,
 * keyed to the agent whose connection is being cut over.
 */
export interface RemoteAgentUpdatePending {
  agentId: string;
  /** Version of the desktop that requested the update (`"unknown"` if unread). */
  requestedByVersion: string;
  /** How long the agent expects to be unavailable, for the restart progress. */
  estimatedRestartSecs: number;
}

/**
 * Subscribe to `agent.update_pending` notifications forwarded by the backend as
 * `remote-agent-update-pending` Tauri events (#1602). Fires on a host *other*
 * than the one initiating a coordinated update; the frontend suspends the
 * affected session and queues an auto-reconnect. Returns the unlisten handle.
 */
export async function onRemoteAgentUpdatePending(
  callback: (pending: RemoteAgentUpdatePending) => void
): Promise<UnlistenFn> {
  return await listen<RemoteAgentUpdatePendingPayload>("remote-agent-update-pending", (event) => {
    callback({
      agentId: event.payload.agent_id,
      requestedByVersion: event.payload.requestedByVersion,
      estimatedRestartSecs: event.payload.estimatedRestartSecs,
    });
  });
}

interface VscodeEditCompletePayload {
  remotePath: string;
  success: boolean;
  error: string | null;
}

/** Subscribe to VS Code edit-complete events (remote file re-upload). */
export async function onVscodeEditComplete(
  callback: (remotePath: string, success: boolean, error: string | null) => void
): Promise<UnlistenFn> {
  return await listen<VscodeEditCompletePayload>("vscode-edit-complete", (event) => {
    callback(event.payload.remotePath, event.payload.success, event.payload.error);
  });
}

interface LocalFileChangedPayload {
  watchId: string;
  path: string;
}

/**
 * Subscribe to external on-disk change events for watched local editor files
 * (#1620). The `watchId` identifies which editor instance registered the watch;
 * callers filter to their own id.
 */
export async function onLocalFileChanged(
  callback: (watchId: string, path: string) => void
): Promise<UnlistenFn> {
  return await listen<LocalFileChangedPayload>("local-file-changed", (event) => {
    callback(event.payload.watchId, event.payload.path);
  });
}

interface LocalDirChangedPayload {
  watchId: string;
  path: string;
}

/**
 * Subscribe to external on-disk change events for a watched local directory
 * (#1626) — a direct child added / removed / renamed / modified. The `watchId`
 * identifies which file-browser instance registered the watch; callers filter
 * to their own id and refresh the listing.
 */
export async function onLocalDirChanged(
  callback: (watchId: string, path: string) => void
): Promise<UnlistenFn> {
  return await listen<LocalDirChangedPayload>("local-dir-changed", (event) => {
    callback(event.payload.watchId, event.payload.path);
  });
}

/** Subscribe to real-time log entry events from the backend. */
export async function onLogEntry(callback: (entry: LogEntry) => void): Promise<UnlistenFn> {
  return await listen<LogEntry>("log-entry", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to tunnel status change events. */
export async function onTunnelStatusChanged(
  callback: (state: TunnelState) => void
): Promise<UnlistenFn> {
  return await listen<TunnelState>("tunnel-status-changed", (event) => {
    callback(event.payload);
  });
}

interface TunnelStatsPayload {
  tunnel_id: string;
  stats: TunnelStats;
}

/** Subscribe to tunnel stats update events. */
export async function onTunnelStatsUpdated(
  callback: (tunnelId: string, stats: TunnelStats) => void
): Promise<UnlistenFn> {
  return await listen<TunnelStatsPayload>("tunnel-stats-updated", (event) => {
    callback(event.payload.tunnel_id, event.payload.stats);
  });
}

// --- Credential store events ---

/**
 * Subscribe to credential store locked events.
 *
 * The callback receives `auto`: `true` when the store auto-locked after
 * inactivity, `false` for a manual/mode-switch lock. This lets callers toast
 * only on auto-lock (G7, #1144) without double-toasting the manual lock.
 */
export async function onCredentialStoreLocked(
  callback: (auto: boolean) => void
): Promise<UnlistenFn> {
  return await listen<{ auto?: boolean } | null>("credential-store-locked", (event) => {
    callback(event.payload?.auto ?? false);
  });
}

/** Subscribe to credential store unlocked events. */
export async function onCredentialStoreUnlocked(callback: () => void): Promise<UnlistenFn> {
  return await listen("credential-store-unlocked", () => {
    callback();
  });
}

/** Subscribe to credential store status change events. */
export async function onCredentialStoreStatusChanged(
  callback: (status: CredentialStoreStatusInfo) => void
): Promise<UnlistenFn> {
  return await listen<CredentialStoreStatusInfo>("credential-store-status-changed", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to credential store unlock-needed events (fired when a credential is requested while locked). */
export async function onCredentialStoreUnlockNeeded(callback: () => void): Promise<UnlistenFn> {
  return await listen("credential-store-unlock-needed", () => {
    callback();
  });
}

/** Subscribe to embedded server status change events. */
export async function onEmbeddedServerStatusChanged(
  callback: (state: ServerState) => void
): Promise<UnlistenFn> {
  return await listen<ServerState>("embedded-server-status-changed", (event) => {
    callback(event.payload);
  });
}

import type { MonitorStatus, SystemStats } from "@/types/monitoring";

interface SessionMonitoringStatsPayload {
  session_id: string;
  stats: SystemStats;
}

/** Subscribe to session-based monitoring stats push events. */
export async function onSessionMonitoringStats(
  callback: (sessionId: string, stats: SystemStats) => void
): Promise<UnlistenFn> {
  return await listen<SessionMonitoringStatsPayload>("session-monitoring-stats", (event) => {
    callback(event.payload.session_id, event.payload.stats);
  });
}

interface SessionMonitoringStatusPayload {
  session_id: string;
  status: MonitorStatus;
}

/**
 * Subscribe to session-based monitoring status push events.
 *
 * Delivers the collector loop's lifecycle transitions (`connecting` → `live` →
 * `stale` → …) so the status bar can render an explicit stale indicator on a
 * mid-stream drop (#1229, audit gap G1).
 */
export async function onSessionMonitoringStatus(
  callback: (sessionId: string, status: MonitorStatus) => void
): Promise<UnlistenFn> {
  return await listen<SessionMonitoringStatusPayload>("session-monitoring-status", (event) => {
    callback(event.payload.session_id, event.payload.status);
  });
}

// --- Persistent session events ---

interface PersistentSessionStatePayload {
  connection_id: string;
  session_id: string | null;
  state: string;
  attached_tab_count: number;
  error_message: string | null;
}

/** Parsed persistent session state change notification. */
export interface PersistentSessionStateChange {
  connectionId: string;
  sessionId: string | null;
  state: string;
  attachedTabCount: number;
  errorMessage: string | null;
}

/** Subscribe to persistent session state change events from the backend. */
export async function onPersistentSessionStateChanged(
  callback: (change: PersistentSessionStateChange) => void
): Promise<UnlistenFn> {
  return await listen<PersistentSessionStatePayload>(
    "persistent-session-state-changed",
    (event) => {
      callback({
        connectionId: event.payload.connection_id,
        sessionId: event.payload.session_id,
        state: event.payload.state,
        attachedTabCount: event.payload.attached_tab_count,
        errorMessage: event.payload.error_message,
      });
    }
  );
}

/** Live status of a single node during a connection-path probe (#962). */
export type HopProbeStatus = "connecting" | "connected" | "failed";

/** Payload of a `jump-host-hop-status` event (already camelCase from Rust). */
export interface HopStatusPayload {
  probeId: string;
  /** Zero-based node index along the path (gateway hops first, target last). */
  index: number;
  /** Total probed nodes (gateway hops + target). */
  total: number;
  host: string;
  port: number;
  status: HopProbeStatus;
  /** Failure reason for a `failed` status; empty otherwise. */
  message: string;
}

/** Payload of a `jump-host-probe-complete` event. */
export interface ProbeCompletePayload {
  probeId: string;
  /** `true` when every node was reached; `false` when a hop failed. */
  success: boolean;
}

/**
 * Subscribe to per-hop status updates emitted while probing a connection path
 * (the "Show Connection Path" popover). Each node fires `connecting` then a
 * resolved `connected` / `failed`, keyed by the probe's `probeId` (#962).
 */
export async function onJumpHostHopStatus(
  callback: (payload: HopStatusPayload) => void
): Promise<UnlistenFn> {
  return await listen<HopStatusPayload>("jump-host-hop-status", (event) => {
    callback(event.payload);
  });
}

/** Subscribe to the one-shot `jump-host-probe-complete` event for a probe (#962). */
export async function onJumpHostProbeComplete(
  callback: (payload: ProbeCompletePayload) => void
): Promise<UnlistenFn> {
  return await listen<ProbeCompletePayload>("jump-host-probe-complete", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to per-transfer SFTP progress (#1245). Each in-flight transfer
 * emits `transferring` updates (with `transferred`/`total`; `total = 0` means
 * indeterminate) then one terminal `done` / `cancelled` / `error` event. The
 * store folds these into its `transfers` map (#1247). Returns the unlisten
 * handle.
 */
export async function onTransferProgress(
  callback: (progress: TransferProgress) => void
): Promise<UnlistenFn> {
  return await listen<TransferProgress>("transfer-progress", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to X server provisioning progress emitted during `x_server_ensure`
 * (download / launch / verify steps). `progress = -1` marks an indeterminate
 * step. Returns the unlisten handle (#1053).
 */
export async function onXServerProgress(
  callback: (progress: XServerProgress) => void
): Promise<UnlistenFn> {
  return await listen<XServerProgress>("x-server-progress", (event) => {
    callback(event.payload);
  });
}

/**
 * Explicit spawn-kind discriminator (#1465). Mirrors the Rust `SpawnKind`
 * (snake_case wire tokens). Consumers branch on this authoritative field rather
 * than inferring intent from which optional fields are set. Pre-#1465 payloads
 * omit it and are treated as `"auto"`, resolved by falling back to
 * presence-based inference.
 */
export type SpawnKind = "container" | "local" | "wsl" | "ssh" | "auto";

/**
 * Payload of a `spawn-request` event (#1364). Emitted by the backend IPC
 * rendezvous when an external `termiHub spawn …` invocation reaches the running
 * instance. Fields mirror the Rust `SpawnRequest` (snake_case; all optional
 * except `kind`, which defaults to `"auto"` on the wire).
 */
export interface SpawnRequestPayload {
  /** Filesystem path (folder or file) the session should open at. */
  location?: string;
  /** Identifier of the context-menu entry that triggered the spawn. */
  entry_id?: string;
  /** Explicit connection id override. */
  connection?: string;
  /** Open in a fresh window instead of attaching to the running instance. */
  new_window?: boolean;
  /** Force the interactive session picker. */
  pick?: boolean;
  /** Docker/Podman image for a "new container" spawn (marks a container spawn). */
  container_image?: string;
  /** Mount target path inside the container. */
  container_mount?: string;
  /**
   * Explicit spawn-kind discriminator (#1465). Absent on pre-#1465 payloads,
   * where it is treated as `"auto"` and resolved by presence-based inference.
   */
  kind?: SpawnKind;
}

/**
 * Subscribe to `spawn-request` events (#1364/#1446). Each event is one external
 * spawn invocation the running instance should act on. Returns the unlisten
 * handle.
 */
export async function onSpawnRequest(
  callback: (payload: SpawnRequestPayload) => void
): Promise<UnlistenFn> {
  return await listen<SpawnRequestPayload>("spawn-request", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to `spawn-picker-requested` events (SI-3, #1366). Emitted instead of
 * `spawn-request` when an invocation asked for the interactive Session Picker
 * (`--pick`), so the target is chosen before anything is opened. The payload is
 * the same {@link SpawnRequestPayload}, carrying the request's `location`,
 * `entry_id` and `new_window` context into the picker. Returns the unlisten
 * handle.
 */
export async function onSpawnPickerRequested(
  callback: (payload: SpawnRequestPayload) => void
): Promise<UnlistenFn> {
  return await listen<SpawnRequestPayload>("spawn-picker-requested", (event) => {
    callback(event.payload);
  });
}

/**
 * Subscribe to connect-time X server download-consent prompts (#1116). Emitted
 * when opening an X11-forwarding SSH connection would need to download the X
 * dependency and the user has not consented yet; the connect pauses until the
 * frontend replies via `xServerConnectConsentReply` with the payload `id`.
 * Returns the unlisten handle.
 */
export async function onXServerConsentNeeded(
  callback: (request: XServerConsentRequest) => void
): Promise<UnlistenFn> {
  return await listen<XServerConsentRequest>("x-server-consent-needed", (event) => {
    callback(event.payload);
  });
}
