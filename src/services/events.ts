/**
 * Tauri event listener setup.
 */

import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { LogEntry } from "@/types/terminal";
import { TunnelState, TunnelStats } from "@/types/tunnel";

interface TerminalOutputPayload {
  session_id: string;
  data: number[];
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
    callback(session_id, new Uint8Array(data));
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
 * Singleton dispatcher that registers one global Tauri listener for each
 * terminal event type and routes events to per-session callbacks via Map
 * lookup. This replaces the O(N) fan-out pattern where each Terminal
 * component registered its own global listener.
 */
export class TerminalOutputDispatcher {
  private outputCallbacks = new Map<string, (data: Uint8Array) => void>();
  private exitCallbacks = new Map<string, (exitCode: number | null) => void>();
  private remoteStateCallbacks = new Map<string, (state: string) => void>();
  private agentStateCallbacks = new Map<string, (state: string) => void>();
  /** Buffer output for sessions whose subscriber hasn't registered yet. */
  private pendingOutput = new Map<string, Uint8Array[]>();
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
      const cb = this.outputCallbacks.get(session_id);
      if (cb) {
        cb(new Uint8Array(data));
      } else {
        // Buffer output for sessions whose subscriber hasn't registered yet
        // (e.g. pre-existing sessions created by agent setup).
        let buf = this.pendingOutput.get(session_id);
        if (!buf) {
          buf = [];
          this.pendingOutput.set(session_id, buf);
        }
        buf.push(new Uint8Array(data));
      }
    });

    if (gen !== this.initGeneration) {
      unlistenOutput();
      return;
    }
    this.unlistenOutput = unlistenOutput;

    const unlistenExit = await listen<TerminalExitPayload>("terminal-exit", (event) => {
      const { session_id, exit_code } = event.payload;
      const cb = this.exitCallbacks.get(session_id);
      if (cb) {
        cb(exit_code);
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
    this.outputCallbacks.set(sessionId, callback);
    // Flush any output that arrived before the subscriber registered
    const buffered = this.pendingOutput.get(sessionId);
    if (buffered) {
      this.pendingOutput.delete(sessionId);
      for (const chunk of buffered) {
        callback(chunk);
      }
    }
    return () => {
      this.outputCallbacks.delete(sessionId);
    };
  }

  /** Subscribe to exit events for a specific session. Returns an unsubscribe function. */
  subscribeExit(sessionId: string, callback: (exitCode: number | null) => void): () => void {
    this.exitCallbacks.set(sessionId, callback);
    return () => {
      this.exitCallbacks.delete(sessionId);
    };
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
