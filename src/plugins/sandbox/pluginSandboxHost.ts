/**
 * Main-thread **host** for the frontend-plugin sandbox worker (#2136).
 *
 * Owns the sandbox worker lifecycle and every interaction with it: loading and
 * unloading plugin code, relaying status-bar widget descriptors into the
 * main-thread store ({@link ./statusBarWidgetStore}), and — the delicate part —
 * driving protocol parsers over terminal output through an **ordered
 * asynchronous pipeline**.
 *
 * ## Ordering
 * The terminal output path is the most ordering-sensitive code in the app. A
 * worker round-trip is asynchronous, so results could in principle arrive out of
 * order; they must reach the terminal in the exact order the chunks were
 * produced. Each session keeps a FIFO of slots: a chunk takes a slot immediately,
 * the transform runs in the worker, and the host **drains from the head** —
 * emitting a slot's bytes only once every earlier slot has resolved. Order is
 * therefore preserved regardless of resolution order.
 *
 * ## Fast path
 * When no parser is registered the terminal never calls into here (see
 * {@link sandboxHasParsers}); that path stays fully synchronous and byte-exact,
 * so the default-off common case is untouched.
 *
 * ## Liveness
 * A runaway plugin can no longer freeze the UI thread (it only occupies the
 * worker). Two guards bound the damage: a per-session pending **cap** passes
 * chunks straight through once the backlog is deep, and a **head-of-line
 * watchdog** force-passes a stuck head chunk so the terminal keeps flowing even
 * if a parser hangs. Both preserve ordering (they resolve slots in place).
 */

import { frontendLog } from "@/utils/frontendLog";
import type { WidgetPosition } from "@/types/plugin";
import type { HostToWorkerMessage, WorkerToHostMessage } from "./protocol";
import {
  clearStatusBarWidgets,
  removeStatusBarWidget,
  upsertStatusBarWidget,
} from "./statusBarWidgetStore";

/** Emit a chunk to the terminal, in order. */
type OutputSink = (bytes: Uint8Array) => void;

/** One output chunk awaiting (or having completed) its transform. */
interface Slot {
  seq: number;
  done: boolean;
  /** The original bytes, kept for byte-exact pass-through. */
  original: Uint8Array;
  /** The bytes to emit once this slot drains (original on pass-through). */
  out: Uint8Array | null;
}

/** Per-session FIFO of slots plus the sink that drains them in order. */
interface SessionQueue {
  slots: Slot[];
  sink: OutputSink;
}

/** Pass chunks straight through once a session's backlog reaches this depth. */
const MAX_PENDING_PER_SESSION = 1024;
/** Force-pass a stuck head chunk after this long, so the terminal keeps flowing. */
const HEAD_WATCHDOG_MS = 500;

let worker: Worker | null = null;
let hasParsers = false;
/** Plugin ids currently loaded in the sandbox; drives worker create/dispose. */
const loadedPlugins = new Set<string>();
let seqCounter = 0;
/** True after a head chunk timed out; new chunks pass through until the worker recovers. */
let degraded = false;
let headTimer: ReturnType<typeof setTimeout> | null = null;

const sessions = new Map<string, SessionQueue>();
const pending = new Map<number, { sessionId: string; slot: Slot }>();

/** Default worker factory — overridable in tests via {@link __setSandboxWorkerFactory}. */
let workerFactory: () => Worker = () =>
  new Worker(new URL("./pluginSandboxWorker.ts", import.meta.url), {
    type: "classic",
    name: "termihub-plugin-sandbox",
  });

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = workerFactory();
  w.addEventListener("message", (e: MessageEvent<WorkerToHostMessage>) => handleMessage(e.data));
  worker = w;
  return w;
}

function post(message: HostToWorkerMessage, transfer?: Transferable[]): void {
  ensureWorker().postMessage(message, transfer ?? []);
}

function disposeWorkerIfIdle(): void {
  if (loadedPlugins.size > 0 || !worker) return;
  worker.terminate();
  worker = null;
  hasParsers = false;
  degraded = false;
  if (headTimer) {
    clearTimeout(headTimer);
    headTimer = null;
  }
  sessions.clear();
  pending.clear();
  clearStatusBarWidgets();
}

// ─── Worker → host ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function handleMessage(msg: WorkerToHostMessage): void {
  switch (msg.t) {
    case "ready":
      break;
    case "parsersActive":
      hasParsers = msg.active;
      break;
    case "transformResult":
      // Any reply means the worker is making progress again.
      degraded = false;
      resolveSlot(msg.seq, msg.changed ? (msg.bytes ?? null) : null);
      break;
    case "widgetUpsert":
      upsertStatusBarWidget(msg.key, msg.position as WidgetPosition, msg.widgetId, msg.node);
      break;
    case "widgetRemove":
      removeStatusBarWidget(msg.key);
      break;
    case "loadError":
      frontendLog(
        "plugin_sandbox",
        `Plugin "${msg.pluginId}" failed to execute in the sandbox: ${msg.message}`
      );
      break;
    case "log":
      frontendLog("plugin_sandbox", msg.message);
      break;
  }
}

/** Mark a slot resolved (`out === null` → pass-through) and drain its session. */
function resolveSlot(seq: number, out: Uint8Array | null): void {
  const entry = pending.get(seq);
  if (!entry) return; // already force-resolved by the watchdog; ignore the late reply.
  pending.delete(seq);
  entry.slot.out = out ?? entry.slot.original;
  entry.slot.done = true;
  drain(entry.sessionId);
}

/** Emit every resolved slot from the head of a session's FIFO, in order. */
function drain(sessionId: string): void {
  const q = sessions.get(sessionId);
  if (!q) return;
  while (q.slots.length > 0 && q.slots[0].done) {
    const slot = q.slots.shift()!;
    if (slot.out) q.sink(slot.out);
  }
  rearmWatchdog();
}

/**
 * (Re)arm a single timer against the oldest still-pending slot across all
 * sessions. If it is still unresolved when the timer fires, force it (and any
 * other timed-out heads) through as pass-through so the terminal keeps flowing
 * even when a parser hangs the worker.
 */
function rearmWatchdog(): void {
  if (headTimer) {
    clearTimeout(headTimer);
    headTimer = null;
  }
  if (pending.size === 0) return;
  headTimer = setTimeout(onWatchdog, HEAD_WATCHDOG_MS);
}

function onWatchdog(): void {
  headTimer = null;
  if (pending.size === 0) return;
  // The worker did not answer in time — treat it as degraded and force the
  // oldest pending slots through untransformed, preserving order.
  degraded = true;
  const oldest = Math.min(...pending.keys());
  const entry = pending.get(oldest);
  if (entry) resolveSlot(oldest, null);
  rearmWatchdog();
}

// ─── Host → worker: plugin lifecycle ─────────────────────────────────────────

/** Load a plugin's entry-point source(s) into the sandbox and run them. */
export function loadPluginInSandbox(pluginId: string, codes: string[]): void {
  ensureWorker();
  loadedPlugins.add(pluginId);
  post({ t: "load", pluginId, codes });
}

/** Unload a plugin from the sandbox; terminates the worker once none remain. */
export function unloadPluginFromSandbox(pluginId: string): void {
  if (!worker) return;
  post({ t: "unload", pluginId });
  loadedPlugins.delete(pluginId);
  disposeWorkerIfIdle();
}

/** Number of plugins currently loaded in the sandbox (introspection/tests). */
export function sandboxLoadedCount(): number {
  return loadedPlugins.size;
}

// ─── Host → worker: terminal pipeline ────────────────────────────────────────

/**
 * Whether any protocol parser is registered in the sandbox. The terminal uses
 * this as its synchronous fast-path guard: when `false` (and the session has no
 * in-flight work), output is pushed without any sandbox round-trip.
 */
export function sandboxHasParsers(): boolean {
  return hasParsers;
}

/** Whether a session still has queued/in-flight sandbox transforms. */
export function sandboxSessionPending(sessionId: string): boolean {
  const q = sessions.get(sessionId);
  return !!q && q.slots.length > 0;
}

/**
 * Run the registered parsers over one output chunk, emitting the (possibly
 * transformed) bytes to `sink` **in arrival order**. Falls back to immediate
 * pass-through when the session backlog is capped or the worker is degraded —
 * still ordered, because the fallback resolves the slot in place.
 */
export function enqueueSandboxTransform(
  sessionId: string,
  bytes: Uint8Array,
  sink: OutputSink
): void {
  let q = sessions.get(sessionId);
  if (!q) {
    q = { slots: [], sink };
    sessions.set(sessionId, q);
  } else {
    q.sink = sink; // a remount can hand us a fresh sink for the same session.
  }

  const seq = seqCounter++;
  const slot: Slot = { seq, done: false, original: bytes, out: null };
  q.slots.push(slot);

  if (degraded || q.slots.length > MAX_PENDING_PER_SESSION) {
    // Backpressure / degraded: skip the round-trip and pass the chunk through.
    // The slot stays in the FIFO and is resolved in place, so ordering behind
    // any still-pending earlier slots is preserved.
    slot.out = bytes;
    slot.done = true;
    drain(sessionId);
    return;
  }

  pending.set(seq, { sessionId, slot });
  // Send a copy of the bytes (structured clone) — the host keeps the original
  // for byte-exact pass-through.
  post({ t: "transform", seq, sessionId, bytes });
  rearmWatchdog();
}

/** Notify the sandbox that a terminal session started (parser lifecycle hook). */
export function sandboxNotifySessionStart(sessionId: string): void {
  if (!worker) return;
  post({ t: "sessionStart", sessionId });
}

/** Notify the sandbox that a terminal session ended (parser lifecycle hook). */
export function sandboxNotifySessionEnd(sessionId: string): void {
  if (!worker) return;
  post({ t: "sessionEnd", sessionId });
}

/**
 * Drop a session's queue on teardown (tab close). Unresolved slots are
 * discarded — the tab is going away, so a few final transformed chunks are
 * acceptable to lose, and this avoids awaiting the worker in a sync cleanup.
 */
export function discardSandboxSession(sessionId: string): void {
  const q = sessions.get(sessionId);
  if (!q) return;
  for (const slot of q.slots) pending.delete(slot.seq);
  sessions.delete(sessionId);
  rearmWatchdog();
}

// ─── Test-only hooks ─────────────────────────────────────────────────────────

/** Override the worker factory (tests only). */
export function __setSandboxWorkerFactory(factory: (() => Worker) | null): void {
  workerFactory =
    factory ??
    (() =>
      new Worker(new URL("./pluginSandboxWorker.ts", import.meta.url), {
        type: "classic",
        name: "termihub-plugin-sandbox",
      }));
}

/** Reset all sandbox host state (tests only). */
export function __resetSandboxHost(): void {
  if (worker) worker.terminate();
  worker = null;
  hasParsers = false;
  loadedPlugins.clear();
  seqCounter = 0;
  degraded = false;
  if (headTimer) {
    clearTimeout(headTimer);
    headTimer = null;
  }
  sessions.clear();
  pending.clear();
  clearStatusBarWidgets();
}
