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
 *
 * ## Crash recovery (#2857)
 * A worker that crashes {@link MAX_WORKER_ERRORS} times in a row is torn down and
 * the terminal reverts to the synchronous fast path. The host then **self-heals**:
 * after an exponential backoff it builds a fresh worker and re-loads every tracked
 * plugin. Rebuilds are bounded ({@link MAX_REBUILDS}) so a deterministically
 * crashing plugin cannot cause a crash loop — once the budget is spent the sandbox
 * stays degraded and the LogViewer names the suspect plugin(s). When a crash can be
 * attributed to one plugin (the `ErrorEvent.filename` points at its `plugin://`
 * entry point) only that plugin is disabled and the rest are reloaded. The terminal
 * never waits on a rebuild: `sandboxHasParsers()` stays false until the fresh
 * worker reports parsers again.
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
/**
 * Tear the worker down and fall back to the synchronous fast path after this many
 * consecutive uncaught worker errors — a worker that keeps crashing on untrusted
 * plugin code should not keep taking terminal output round-trips.
 */
const MAX_WORKER_ERRORS = 3;
/** Rebuild delay after the first crash-teardown; doubles on each further rebuild. */
const REBUILD_BASE_DELAY_MS = 1000;
/** Upper bound on the rebuild backoff. */
const REBUILD_MAX_DELAY_MS = 30_000;
/**
 * Consecutive rebuilds allowed before giving up and staying on the fast path. A
 * rebuilt worker that survives {@link REBUILD_STABLE_MS} refills the budget.
 */
const MAX_REBUILDS = 3;
/** A rebuilt worker alive this long without a teardown counts as healed. */
const REBUILD_STABLE_MS = 60_000;

let worker: Worker | null = null;
let hasParsers = false;
/**
 * Plugins tracked by the sandbox (id → entry URLs); drives worker create/dispose
 * and lets a rebuilt worker re-load them after a crash-teardown.
 */
const loadedPlugins = new Map<string, string[]>();
/** Tracked plugins whose `load` has been posted to the *current* worker. */
const workerPlugins = new Set<string>();
/**
 * Tracked plugins disabled because a worker crash was attributed to them. They
 * are not re-loaded into a rebuilt worker until explicitly unloaded + reloaded.
 */
const quarantined = new Set<string>();
let seqCounter = 0;
/** True after a head chunk timed out; new chunks pass through until the worker recovers. */
let degraded = false;
let headTimer: ReturnType<typeof setTimeout> | null = null;
/** Consecutive uncaught worker errors since the worker last made progress. */
let workerErrorCount = 0;
/** Plugin each of those consecutive errors was attributed to (`null` = unknown). */
let faultAttribution: (string | null)[] = [];
/** Rebuilds performed since the sandbox was last healthy (bounded by MAX_REBUILDS). */
let rebuildAttempts = 0;
/** Pending backoff before the next rebuild. */
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
/** Refills the rebuild budget once a rebuilt worker has stayed up long enough. */
let stableTimer: ReturnType<typeof setTimeout> | null = null;

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
  // A worker built for any reason supersedes a pending backoff rebuild.
  cancelRebuild();
  const w = workerFactory();
  workerErrorCount = 0;
  faultAttribution = [];
  workerPlugins.clear();
  w.addEventListener("message", (e: MessageEvent<WorkerToHostMessage>) => {
    if (worker === w) handleMessage(e.data);
  });
  // An uncaught throw or a dead worker must not silently hang outstanding slots:
  // surface it, and force every pending chunk through untransformed.
  w.addEventListener("error", (e: ErrorEvent) => {
    if (worker === w) handleWorkerFault("error", e.message || "uncaught error", e.filename);
  });
  w.addEventListener("messageerror", () => {
    if (worker === w)
      handleWorkerFault("messageerror", "failed to deserialize a message from the worker");
  });
  worker = w;
  // After a crash-teardown, any fresh worker (backoff rebuild or explicit load)
  // that stays up long enough refills the rebuild budget.
  if (rebuildAttempts > 0) armStableTimer();
  return w;
}

/** Tracked plugin ids that are not quarantined, in load order. */
function activePluginIds(): string[] {
  return Array.from(loadedPlugins.keys()).filter((id) => !quarantined.has(id));
}

/** Post `load` for every active tracked plugin the current worker does not have yet. */
function syncWorkerPlugins(): void {
  for (const id of activePluginIds()) {
    if (workerPlugins.has(id)) continue;
    workerPlugins.add(id);
    post({ t: "load", pluginId: id, entryUrls: loadedPlugins.get(id) ?? [] });
  }
}

/**
 * Attribute a worker error to a tracked plugin from the error's source file.
 * Plugin code is `importScripts`-ed from `<origin>/load/<encoded id>/<path>`
 * (`plugin://localhost` or `http://plugin.localhost`), so an uncaught throw from
 * plugin code — including one from its timers/promises — names that URL.
 */
function attributeFault(filename: string | undefined): string | null {
  if (!filename) return null;
  for (const [id, urls] of loadedPlugins) {
    if (urls.includes(filename)) return id;
  }
  const match = /^(?:plugin:\/\/localhost|https?:\/\/plugin\.localhost)\/load\/([^/?#]+)\//.exec(
    filename
  );
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return loadedPlugins.has(id) ? id : null;
}

/**
 * Handle an uncaught worker `error` / `messageerror`. **Best-effort — must never
 * throw** (it runs on the liveness hot path). Surface the fault to the LogViewer,
 * force every outstanding slot through untransformed so a dead or crashing worker
 * cannot hang the terminal, and — once the worker has crashed {@link
 * MAX_WORKER_ERRORS} times in a row — tear it down and revert to the synchronous
 * fast path so untrusted plugin code can no longer take output round-trips.
 */
function handleWorkerFault(
  kind: "error" | "messageerror",
  detail: string,
  filename?: string
): void {
  try {
    workerErrorCount++;
    const culprit = attributeFault(filename);
    faultAttribution.push(culprit);
    frontendLog(
      "plugin_sandbox",
      `Sandbox worker ${kind} (#${workerErrorCount})` +
        (culprit ? ` in plugin "${culprit}"` : "") +
        `: ${detail}. Passing outstanding terminal output through untransformed.`
    );
    // Treat the worker as degraded: outstanding slots and new chunks pass through.
    degraded = true;
    forceDrainPending();
    if (workerErrorCount >= MAX_WORKER_ERRORS) {
      frontendLog(
        "plugin_sandbox",
        `Sandbox worker crashed ${workerErrorCount} times; tearing it down and ` +
          `reverting the terminal to the synchronous fast path.`
      );
      const attribution = faultAttribution;
      teardownFaultyWorker();
      quarantineCulprits(attribution);
      scheduleRebuild(attribution);
    }
  } catch {
    // The fault handler is a liveness guard — swallow anything it hits so it can
    // never itself break the terminal it exists to protect.
  }
}

/** Force every pending slot through as untransformed pass-through, in order. */
function forceDrainPending(): void {
  // Snapshot the keys first (array spread is bounded by the heap, unlike a
  // call-argument spread) — `resolveSlot` mutates `pending` as it drains.
  for (const seq of Array.from(pending.keys())) resolveSlot(seq, null);
}

/**
 * Terminate a repeatedly-crashing worker and revert to the fast path. Plugins
 * stay in {@link loadedPlugins}, so a rebuilt worker (backoff, or an explicit
 * load) can re-load them; until then `sandboxHasParsers()` is false and the
 * terminal runs synchronously.
 */
function teardownFaultyWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  workerPlugins.clear();
  hasParsers = false; // → sandboxHasParsers() false → terminal reverts to fast path
  degraded = false;
  workerErrorCount = 0;
  faultAttribution = [];
  clearStableTimer();
  if (headTimer) {
    clearTimeout(headTimer);
    headTimer = null;
  }
  // The dead worker's widgets are stale; the reloaded plugins re-upsert theirs.
  clearStatusBarWidgets();
}

/**
 * Disable the plugin(s) a majority of the teardown's crashes were attributed to,
 * so a single deterministically-crashing plugin does not take the whole sandbox
 * (and every other plugin) down with it.
 */
function quarantineCulprits(attribution: (string | null)[]): void {
  const counts = new Map<string, number>();
  for (const id of attribution) {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n * 2 <= attribution.length || !loadedPlugins.has(id)) continue;
    quarantined.add(id);
    frontendLog(
      "plugin_sandbox",
      `Plugin "${id}" repeatedly crashed the sandbox worker and has been disabled. ` +
        `Disable and re-enable it to try loading it again.`
    );
  }
}

/** Current backoff before the next rebuild: base · 2^attempts, capped. */
function rebuildDelay(): number {
  return Math.min(REBUILD_BASE_DELAY_MS * 2 ** rebuildAttempts, REBUILD_MAX_DELAY_MS);
}

/**
 * After a crash-teardown, schedule a fresh worker (with every active plugin
 * re-loaded) after an exponential backoff — or, once {@link MAX_REBUILDS} is
 * spent, stay on the fast path and name the suspect plugin(s) in the LogViewer.
 */
function scheduleRebuild(attribution: (string | null)[]): void {
  cancelRebuild();
  const active = activePluginIds();
  if (active.length === 0) return;
  if (rebuildAttempts >= MAX_REBUILDS) {
    const attributed = Array.from(new Set(attribution.filter((id): id is string => !!id)));
    const suspects = (attributed.length > 0 ? attributed : active)
      .map((id) => `"${id}"`)
      .join(", ");
    frontendLog(
      "plugin_sandbox",
      `Sandbox worker kept crashing after ${MAX_REBUILDS} rebuilds; giving up and ` +
        `leaving frontend plugins disabled (terminal output passes through ` +
        `untransformed). Suspect plugin(s): ${suspects}. Disable the offending ` +
        `plugin, then re-enable plugins to retry.`
    );
    return;
  }
  const delay = rebuildDelay();
  frontendLog(
    "plugin_sandbox",
    `Rebuilding the sandbox worker in ${delay} ms (attempt ${rebuildAttempts + 1}/` +
      `${MAX_REBUILDS}) and reloading ${active.length} plugin(s).`
  );
  rebuildTimer = setTimeout(rebuildWorker, delay);
}

/** Backoff elapsed: build a fresh worker and re-load every active plugin. */
function rebuildWorker(): void {
  rebuildTimer = null;
  try {
    if (worker || activePluginIds().length === 0) return;
    rebuildAttempts++;
    ensureWorker();
    syncWorkerPlugins();
  } catch (err) {
    // Building the worker itself failed — stay on the fast path, never throw.
    frontendLog(
      "plugin_sandbox",
      `Failed to rebuild the sandbox worker: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function cancelRebuild(): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
}

function armStableTimer(): void {
  clearStableTimer();
  stableTimer = setTimeout(() => {
    stableTimer = null;
    rebuildAttempts = 0; // the rebuilt worker stayed up → the sandbox healed
  }, REBUILD_STABLE_MS);
}

function clearStableTimer(): void {
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

function post(message: HostToWorkerMessage, transfer?: Transferable[]): void {
  ensureWorker().postMessage(message, transfer ?? []);
}

function disposeWorkerIfIdle(): void {
  if (activePluginIds().length > 0) return;
  cancelRebuild();
  clearStableTimer();
  if (!worker) return;
  worker.terminate();
  worker = null;
  workerPlugins.clear();
  hasParsers = false;
  degraded = false;
  workerErrorCount = 0;
  faultAttribution = [];
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
      workerErrorCount = 0;
      faultAttribution = [];
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
  // Running min via iteration — never spread `pending.keys()` into a call:
  // `pending` is unbounded in aggregate (only capped per session), so
  // `Math.min(...keys)` can throw `RangeError` past the engine's argument limit,
  // exactly inside the watchdog meant to keep the terminal flowing.
  let oldest = Infinity;
  for (const seq of pending.keys()) {
    if (seq < oldest) oldest = seq;
  }
  if (oldest !== Infinity) resolveSlot(oldest, null);
  rearmWatchdog();
}

// ─── Host → worker: plugin lifecycle ─────────────────────────────────────────

/**
 * Load a plugin's entry point(s) into the sandbox and run them. `entryUrls` are
 * the plugin's entry points on the app-controlled `plugin://` origin, which the
 * worker `importScripts` in order (#2266).
 */
export function loadPluginInSandbox(pluginId: string, entryUrls: string[]): void {
  // An explicit (re)load is a fresh chance for a previously quarantined plugin.
  quarantined.delete(pluginId);
  loadedPlugins.set(pluginId, entryUrls);
  // Builds the worker if absent — including mid-backoff after a crash-teardown,
  // in which case every other tracked plugin is re-loaded along with this one.
  ensureWorker();
  syncWorkerPlugins();
}

/** Unload a plugin from the sandbox; terminates the worker once none remain. */
export function unloadPluginFromSandbox(pluginId: string): void {
  if (worker && workerPlugins.has(pluginId)) {
    post({ t: "unload", pluginId });
  }
  workerPlugins.delete(pluginId);
  loadedPlugins.delete(pluginId);
  quarantined.delete(pluginId);
  disposeWorkerIfIdle();
}

/** Number of plugins tracked by the sandbox, quarantined included (introspection/tests). */
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

  if (degraded || !worker || q.slots.length > MAX_PENDING_PER_SESSION) {
    // Backpressure / degraded / worker torn down (awaiting a rebuild): skip the
    // round-trip and pass the chunk through — never spawn a worker from here.
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
  workerPlugins.clear();
  quarantined.clear();
  seqCounter = 0;
  degraded = false;
  workerErrorCount = 0;
  faultAttribution = [];
  rebuildAttempts = 0;
  cancelRebuild();
  clearStableTimer();
  if (headTimer) {
    clearTimeout(headTimer);
    headTimer = null;
  }
  sessions.clear();
  pending.clear();
  clearStatusBarWidgets();
}
