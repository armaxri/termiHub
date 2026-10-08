/**
 * Plugin-sandbox projection bridge (#4188, plugin OS-sandbox phase 6).
 *
 * The shared, read-only `plugin-sandbox` region — backed by the Rust plugin
 * host — is the single source of truth for each native plugin's sandbox: the
 * isolation its runner reported (or why it was refused), the runner's process
 * state and the bridge requests the host recently refused. Settings → Plugins
 * renders its badges from it and the denial toasts are raised from it; the
 * frontend owns none of this state (ADR-14).
 *
 * There are no intents: trusting, revoking and re-enabling go through the
 * plugin commands, whose effect arrives as the next region diff.
 */

import { createTransport, ProjectionClient, type Transport } from "@/services/transport";
import { frontendLog } from "@/utils/frontendLog";
import { errorMessage } from "@/utils/errorMessage";
import { makeVersionGuard } from "./bridgeVersionGuard";

/** The region id (twin of the Rust `PLUGIN_SANDBOX_REGION`). */
export const PLUGIN_SANDBOX_REGION = "plugin-sandbox";

/** The isolation badge (twin of Rust `IsolationStatus`). */
export type IsolationStatus =
  | "full"
  | "reduced"
  | "unconfined"
  | "unavailable"
  | "failed"
  | "runnerMissing";

/** The runner's process state (twin of Rust `ProcessState`). */
export type ProcessState = "running" | "idle" | "restarting" | "disabled";

/** How a plugin runner ended (twin of Rust `PluginExitInfo`). */
export interface PluginExitInfo {
  kind: "stopped" | "crashed" | "notResponding" | "outOfMemory" | "invalidData";
  /** One line for the UI ("plugin process exited: signal SIGSEGV …"). */
  message: string;
}

/** A runner's process status (twin of Rust `ProcessStatus`). */
export interface PluginProcessStatus {
  state: ProcessState;
  sessions: number;
  /** Crashes in the current window ("Restarting (n/3)"). */
  crashes: number;
  maxRestarts: number;
  lastExit?: PluginExitInfo;
  /** "Disabled after 3 crashes". */
  autoDisabled?: string;
}

/** One refused plugin request (twin of Rust `DenialInfo`). */
export interface PluginDenial {
  /** The bridge call (`open_connection`, `read_file`, …) or system call. */
  operation: string;
  /** What was asked for (`host:port` or a path); empty for a system call. */
  target: string;
  /** `permission`, `resourceLimit` or `syscall` (a kernel-level denial); a
   * string so a reason the host adds later still renders. */
  reason: string;
  atMs: number;
  /** How many refused calls this entry stands for (a kernel-level `syscall`
   * report folds repeats; 1 for a bridge denial). */
  count: number;
}

/** One plugin's sandbox status (twin of Rust `PluginSandboxStatus`). */
export interface PluginSandboxStatus {
  isolation: IsolationStatus;
  enforced: string[];
  missing: string[];
  detail?: string;
  process?: PluginProcessStatus;
  denials: PluginDenial[];
}

/** The region view model (twin of Rust `PluginSandboxView`). */
export interface PluginSandboxView {
  plugins: Record<string, PluginSandboxStatus>;
}

/** The view before the region arrives: no sandbox information. */
export const EMPTY_SANDBOX_VIEW: PluginSandboxView = { plugins: {} };

let transportInstance: Transport | null = null;
let regionClient: ProjectionClient | null = null;
let startPromise: Promise<ProjectionClient> | null = null;
let lastView: PluginSandboxView = EMPTY_SANDBOX_VIEW;
const versionGuard = makeVersionGuard();

/** A change listener for the projected view. */
export type PluginSandboxListener = (view: PluginSandboxView) => void;
const listeners = new Set<PluginSandboxListener>();

/** Inject a transport for tests; `null` restores the real one. */
export function setPluginSandboxTransportForTest(t: Transport | null): void {
  regionClient?.stop();
  regionClient = null;
  startPromise = null;
  transportInstance = t;
  lastView = EMPTY_SANDBOX_VIEW;
  versionGuard.reset();
}

function transport(): Transport {
  if (!transportInstance) transportInstance = createTransport();
  return transportInstance;
}

function commit(view: PluginSandboxView, version: number): void {
  if (!versionGuard.shouldApply(version)) return;
  lastView = view;
  for (const listener of listeners) {
    try {
      listener(view);
    } catch (err) {
      logPluginSandboxBridge("listener", err);
    }
  }
}

/** Register a listener for every projected view; returns an unsubscribe. */
export function onPluginSandboxView(listener: PluginSandboxListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last projected view (empty until the region arrives). */
export function currentPluginSandboxView(): PluginSandboxView {
  return lastView;
}

/**
 * Subscribe to the region (idempotent, shared by every consumer). A failure is
 * logged and rethrown so the caller can stay on the last-known view.
 */
export function ensurePluginSandboxSubscribed(): Promise<ProjectionClient> {
  if (regionClient) return Promise.resolve(regionClient);
  if (!startPromise) {
    const client = new ProjectionClient(transport(), PLUGIN_SANDBOX_REGION);
    client.onChange((state) => {
      const view = (state.view ?? EMPTY_SANDBOX_VIEW) as Partial<PluginSandboxView>;
      commit({ plugins: view.plugins ?? {} }, state.version);
    });
    startPromise = client
      .start()
      .then(() => {
        regionClient = client;
        return client;
      })
      .catch((err) => {
        startPromise = null;
        logPluginSandboxBridge("subscribe", err);
        throw err;
      });
  }
  return startPromise;
}

/** Log a bridge failure to the Log Viewer. */
export function logPluginSandboxBridge(stage: string, err: unknown): void {
  frontendLog("plugin_sandbox_bridge", `${stage} failed: ${errorMessage(err)}`);
}
