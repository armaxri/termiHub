/**
 * The frontend-plugin registration surface and registries — the code that runs
 * **inside the sandbox worker** ({@link ./pluginSandboxWorker}), part of the
 * plugin sandbox work (#2136).
 *
 * A frontend plugin ships a plain JavaScript entry point (`frontend/index.js`).
 * Inside the sandbox, that script receives its **own** {@link TermiHubPluginAPI}
 * instance (bound to its plugin id via {@link makePluginApi}) and uses it to
 * register two kinds of extension:
 *
 * - **Protocol parsers** — `transform(data, sessionId)` runs over each chunk of
 *   terminal output (concept §8). Applied by {@link applyParsers}.
 * - **Status-bar widgets** — `render()` returns a serialisable {@link WidgetNode}
 *   (the worker has no DOM); the host materialises it. `dispose()` tears it down.
 *
 * This module is deliberately free of any DOM, Tauri/IPC, or React import so the
 * register/transform/dispose logic stays pure and unit-testable, and so it can
 * load in a Worker realm. Every call *into* plugin code — `transform`,
 * `onSessionStart`/`onSessionEnd`, `render`, `dispose` — is wrapped so a throw
 * from one bad plugin can never break the pipeline (concept "Error Handling").
 * Errors go through {@link @/utils/frontendLog}; inside the worker those entries
 * are bridged back to the host's LogViewer.
 *
 * Concept: `docs/concepts/implemented/plugin-system.html` (§8, §13).
 */

import { frontendLog } from "@/utils/frontendLog";
import type { WidgetPosition } from "@/types/plugin";
import type { ProtocolParser, StatusBarWidget, TermiHubPluginAPI, WidgetNode } from "./protocol";

export type { ProtocolParser, StatusBarWidget, TermiHubPluginAPI, WidgetNode };

/** A protocol parser plus the id of the plugin that registered it. */
interface RegisteredParser {
  pluginId: string;
  parser: ProtocolParser;
}

/** A status-bar widget plus the id of the plugin that registered it. */
interface RegisteredWidget {
  pluginId: string;
  widget: StatusBarWidget;
}

// ─── Registries ──────────────────────────────────────────────────────────────

let parsers: RegisteredParser[] = [];
let widgets: RegisteredWidget[] = [];

/**
 * Plugin id used when a registration cannot be attributed to a specific plugin —
 * i.e. a call made through the shared global fallback rather than the per-plugin
 * instance a plugin is handed. Injected plugins always register through their own
 * {@link makePluginApi} instance, so this only catches code that reaches for the
 * global directly.
 */
const FALLBACK_PLUGIN_ID = "unknown";

// ─── Event emitters (worker relays these to the host) ─────────────────────────

/** A widget lifecycle event the worker forwards to the host. */
export type WidgetEvent =
  | {
      type: "upsert";
      key: string;
      pluginId: string;
      widgetId: string;
      position: WidgetPosition;
      node: WidgetNode;
    }
  | { type: "remove"; key: string };

const widgetListeners = new Set<(e: WidgetEvent) => void>();
const parsersActiveListeners = new Set<(active: boolean) => void>();
let lastParsersActive = false;

/** Subscribe to widget upsert/remove events. Returns an unsubscribe. */
export function subscribeWidgetEvents(cb: (e: WidgetEvent) => void): () => void {
  widgetListeners.add(cb);
  return () => {
    widgetListeners.delete(cb);
  };
}

/** Subscribe to changes in whether any parser is registered. Returns an unsubscribe. */
export function subscribeParsersActive(cb: (active: boolean) => void): () => void {
  parsersActiveListeners.add(cb);
  return () => {
    parsersActiveListeners.delete(cb);
  };
}

function emitWidget(event: WidgetEvent): void {
  for (const listener of widgetListeners) listener(event);
}

/** Emit a `parsersActive` change only when the boolean actually flips. */
function refreshParsersActive(): void {
  const active = parsers.length > 0;
  if (active === lastParsersActive) return;
  lastParsersActive = active;
  for (const listener of parsersActiveListeners) listener(active);
}

const key = (pluginId: string, widgetId: string): string => `${pluginId}:${widgetId}`;

/** Log a caught error from plugin code without letting it escape. */
function logPluginError(pluginId: string, extId: string, phase: string, err: unknown): void {
  frontendLog(
    "plugin_runtime",
    `Plugin "${pluginId}" ${phase} for "${extId}" threw: ${err instanceof Error ? err.message : String(err)}`
  );
}

// ─── Registration ────────────────────────────────────────────────────────────

function registerProtocolParserFor(pluginId: string, parser: ProtocolParser): void {
  if (
    !parser ||
    typeof parser.id !== "string" ||
    parser.id === "" ||
    typeof parser.transform !== "function"
  ) {
    frontendLog("plugin_runtime", `Plugin "${pluginId}" registered an invalid protocol parser`);
    return;
  }
  // Re-registration of the same (plugin, id) replaces the prior entry.
  parsers = parsers.filter((p) => !(p.pluginId === pluginId && p.parser.id === parser.id));
  parsers.push({ pluginId, parser });
  refreshParsersActive();
}

function registerStatusBarWidgetFor(pluginId: string, widget: StatusBarWidget): void {
  if (
    !widget ||
    typeof widget.id !== "string" ||
    widget.id === "" ||
    typeof widget.render !== "function" ||
    typeof widget.dispose !== "function" ||
    (widget.position !== "left" && widget.position !== "right")
  ) {
    frontendLog("plugin_runtime", `Plugin "${pluginId}" registered an invalid status-bar widget`);
    return;
  }
  widgets = widgets.filter((w) => !(w.pluginId === pluginId && w.widget.id === widget.id));
  widgets.push({ pluginId, widget });

  // Build the declarative snapshot inside the sandbox and emit it for the host
  // to materialise. A throwing render() is logged and the widget skipped, so a
  // bad widget never breaks the status bar (concept "Error Handling").
  let node: WidgetNode;
  try {
    node = widget.render();
  } catch (err) {
    logPluginError(pluginId, widget.id, "render", err);
    return;
  }
  if (!node || typeof node.tag !== "string") {
    frontendLog(
      "plugin_runtime",
      `Plugin "${pluginId}" widget "${widget.id}" render() returned no node`
    );
    return;
  }
  emitWidget({
    type: "upsert",
    key: key(pluginId, widget.id),
    pluginId,
    widgetId: widget.id,
    position: widget.position,
    node,
  });
}

/**
 * Build a {@link TermiHubPluginAPI} instance bound to `pluginId`. Every register
 * call the returned API makes — synchronous top-level, or from a later
 * timer/promise/event callback — is attributed to `pluginId`, so the plugin's
 * registrations are always found and cleanly removed by {@link unregisterPlugin}
 * on disable/uninstall (#2020).
 */
export function makePluginApi(pluginId: string): TermiHubPluginAPI {
  return {
    registerProtocolParser: (parser) => registerProtocolParserFor(pluginId, parser),
    registerStatusBarWidget: (widget) => registerStatusBarWidgetFor(pluginId, widget),
  };
}

/** The global properties this module installs (extracted for testability). */
type TermiHubGlobals = {
  termihub?: TermiHubPluginAPI;
  __termihubMakePluginApi?: (pluginId: string) => TermiHubPluginAPI;
};

/**
 * Install the frontend-plugin globals on the given target (the worker's `self`):
 * the concept-mandated `termihub` (a shared fallback instance) and the internal
 * `__termihubMakePluginApi` bridge the loader wrapper uses to hand each plugin
 * its own instance. Idempotent: the same objects are reused across calls so a
 * previously-captured reference stays valid. Returns the shared `termihub`
 * instance.
 */
export function ensureTermiHubApi(target: TermiHubGlobals): TermiHubPluginAPI {
  if (!target.termihub) {
    target.termihub = makePluginApi(FALLBACK_PLUGIN_ID);
  }
  if (!target.__termihubMakePluginApi) {
    target.__termihubMakePluginApi = makePluginApi;
  }
  return target.termihub;
}

// ─── Protocol parser application ─────────────────────────────────────────────

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** True when at least one protocol parser is registered. */
export function hasProtocolParsers(): boolean {
  return parsers.length > 0;
}

/**
 * Run every registered parser over `data` in registration order. Each parser
 * sees the previous parser's output; a parser returning `null` (or a non-string)
 * leaves the running text unchanged. A parser that throws is caught, logged, and
 * skipped. Returns the final text and whether any parser changed it.
 */
export function applyParsers(data: string, sessionId: string): { text: string; changed: boolean } {
  let text = data;
  let changed = false;
  for (const { pluginId, parser } of parsers) {
    let out: string | null;
    try {
      out = parser.transform(text, sessionId);
    } catch (err) {
      logPluginError(pluginId, parser.id, "transform", err);
      continue;
    }
    if (typeof out === "string") {
      text = out;
      changed = true;
    }
  }
  return { text, changed };
}

/**
 * Apply registered protocol parsers to a raw output chunk. Returns
 * `{ changed: false }` when no parser transforms the chunk (the host keeps the
 * original bytes byte-exact), otherwise `{ changed: true, bytes }` with the
 * UTF-8 encoding of the transformed text.
 */
export function transformChunk(
  bytes: Uint8Array,
  sessionId: string
): { changed: false } | { changed: true; bytes: Uint8Array } {
  const { text, changed } = applyParsers(decoder.decode(bytes), sessionId);
  return changed ? { changed: true, bytes: encoder.encode(text) } : { changed: false };
}

/** Fire one optional session-lifecycle hook across every parser (errors isolated). */
function notifySession(phase: "onSessionStart" | "onSessionEnd", sessionId: string): void {
  for (const { pluginId, parser } of parsers) {
    const hook = parser[phase];
    if (!hook) continue;
    try {
      hook.call(parser, sessionId);
    } catch (err) {
      logPluginError(pluginId, parser.id, phase, err);
    }
  }
}

/** Notify every parser's optional `onSessionStart` hook (errors isolated). */
export function notifySessionStart(sessionId: string): void {
  notifySession("onSessionStart", sessionId);
}

/** Notify every parser's optional `onSessionEnd` hook (errors isolated). */
export function notifySessionEnd(sessionId: string): void {
  notifySession("onSessionEnd", sessionId);
}

// ─── Teardown ────────────────────────────────────────────────────────────────

/**
 * Remove every extension a plugin registered, called when a plugin is disabled
 * or uninstalled. Parsers are dropped; each widget's `dispose()` runs (inside
 * the sandbox, wrapped) and a remove event is emitted so the host unmounts it.
 */
export function unregisterPlugin(pluginId: string): void {
  parsers = parsers.filter((p) => p.pluginId !== pluginId);
  refreshParsersActive();

  const removed = widgets.filter((w) => w.pluginId === pluginId);
  widgets = widgets.filter((w) => w.pluginId !== pluginId);
  for (const { widget } of removed) {
    try {
      widget.dispose();
    } catch (err) {
      logPluginError(pluginId, widget.id, "dispose", err);
    }
    emitWidget({ type: "remove", key: key(pluginId, widget.id) });
  }
}

/** Drop all registered parsers and widgets (used on teardown / in tests). */
export function clearRegistry(): void {
  const removed = widgets.map((w) => ({ pluginId: w.pluginId, id: w.widget.id }));
  parsers = [];
  widgets = [];
  refreshParsersActive();
  for (const { pluginId, id } of removed) emitWidget({ type: "remove", key: key(pluginId, id) });
}
