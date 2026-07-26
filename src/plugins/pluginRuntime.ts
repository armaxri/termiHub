/**
 * Frontend JavaScript plugin runtime — the `window.termihub` registration
 * surface and the registries it feeds (#1998).
 *
 * A frontend plugin is a plain JavaScript file the plugin author ships at
 * `frontend/index.js` (the `entryPoint` its `protocolParser` / `statusBarWidget`
 * extension declares). On activation the loader in {@link ./frontendPlugins}
 * injects that script into the WebView wrapped so the plugin receives its **own**
 * {@link TermiHubPluginAPI} instance (bound to that plugin's id via
 * {@link makePluginApi}); the script calls that API to register two kinds of
 * extension:
 *
 * - **Protocol parsers** — `transform(data, sessionId)` runs over each chunk of
 *   terminal output before it reaches xterm; returning `null` passes the chunk
 *   through unchanged (concept §8).
 * - **Status-bar widgets** — a `render()`/`dispose()` pair mounted into the
 *   left/right status-bar slots by {@link ../components/StatusBar/PluginStatusBarWidgets}.
 *
 * This module is deliberately free of any Tauri/IPC or React import so the
 * register/transform/dispose logic stays pure and unit-testable, mirroring
 * `src/themes/pluginThemes.ts`. Every call *into* plugin code — `transform`,
 * `onSessionStart`/`onSessionEnd`, `render`, `dispose` — is wrapped so a throw
 * from one bad plugin can never break rendering or the status bar (concept
 * "Error Handling").
 *
 * Isolation note: per the concept, frontend plugins share the WebView context
 * (weak isolation). Stronger isolation (Workers/iframes) is an explicit future
 * improvement and out of scope here (#1998).
 *
 * Concept: `docs/concepts/future/plugin-system.html` (impl §8; "Fifth PR —
 * Frontend plugins").
 */

import { frontendLog } from "@/utils/frontendLog";
import type { WidgetPosition } from "@/types/plugin";

/**
 * A protocol parser a frontend plugin registers via
 * {@link TermiHubPluginAPI.registerProtocolParser} (concept §8).
 */
export interface ProtocolParser {
  /** Parser identifier (unique within the plugin). */
  id: string;
  /** Human-readable name. */
  name: string;
  /**
   * Called for each chunk of terminal output. Returns the transformed text, or
   * `null` to pass the chunk through unchanged.
   */
  transform(data: string, sessionId: string): string | null;
  /** Optional: called when a terminal session starts. */
  onSessionStart?(sessionId: string): void;
  /** Optional: called when a terminal session ends. */
  onSessionEnd?(sessionId: string): void;
}

/**
 * A status-bar widget a frontend plugin registers via
 * {@link TermiHubPluginAPI.registerStatusBarWidget} (concept §8).
 */
export interface StatusBarWidget {
  /** Widget identifier (unique within the plugin). */
  id: string;
  /** Which side of the status bar the widget renders on. */
  position: WidgetPosition;
  /** Build the widget's DOM. Called once when the widget mounts. */
  render(): HTMLElement;
  /** Tear the widget down. Called when the plugin is disabled/uninstalled. */
  dispose(): void;
}

/**
 * The API surface exposed to frontend plugins (concept §8). Each plugin receives
 * its **own** instance, whose register calls are permanently attributed to that
 * plugin's id — so a registration made from a timer/promise/event callback lands
 * under the right plugin regardless of when it fires, and is cleanly removed on
 * unload. See {@link makePluginApi}. The concept-mandated `window.termihub` is a
 * shared fallback instance ({@link ensureTermiHubApi}).
 */
export interface TermiHubPluginAPI {
  /** Register a protocol parser (concept §8). */
  registerProtocolParser(parser: ProtocolParser): void;
  /** Register a status-bar widget (concept §8). */
  registerStatusBarWidget(widget: StatusBarWidget): void;
}

declare global {
  interface Window {
    /**
     * The frontend-plugin registration API (#1998), typed per the concept.
     * Present once any plugin has loaded — a shared fallback instance (its
     * registrations attribute to {@link FALLBACK_PLUGIN_ID}). Each injected
     * plugin instead runs against its **own** instance passed in as `termihub`,
     * which shadows this global inside the plugin's scope.
     */
    termihub: TermiHubPluginAPI;
    /**
     * Internal bridge (#2020): builds a per-plugin {@link TermiHubPluginAPI}
     * bound to a plugin id. Installed by {@link ensureTermiHubApi} so the loader's
     * injected wrapper can hand each plugin its own instance. Not part of the
     * concept surface — plugin authors use the `termihub` they are passed.
     */
    __termihubMakePluginApi?: (pluginId: string) => TermiHubPluginAPI;
  }
}

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

/**
 * A status-bar widget projected for rendering, with a stable, collision-proof
 * key (`<pluginId>:<widgetId>`) so two plugins may reuse a widget id.
 */
export interface StatusBarWidgetEntry {
  key: string;
  widget: StatusBarWidget;
}

// ─── Registries ──────────────────────────────────────────────────────────────

let parsers: RegisteredParser[] = [];
let widgets: RegisteredWidget[] = [];

/**
 * Plugin id used when a registration cannot be attributed to a specific plugin —
 * i.e. a call made through the shared `window.termihub` fallback rather than the
 * per-plugin instance a plugin is handed. Injected plugins always register
 * through their own {@link makePluginApi} instance, so this only catches code
 * that reaches for the global directly.
 */
const FALLBACK_PLUGIN_ID = "unknown";

/** Cached per-position widget snapshots for {@link getStatusBarWidgets} (stable refs for `useSyncExternalStore`). */
let widgetSnapshot: Record<WidgetPosition, StatusBarWidgetEntry[]> = { left: [], right: [] };

/** Listeners notified when the widget registry changes (drives the status bar). */
const widgetListeners = new Set<() => void>();

/** Log a caught error from plugin code without letting it escape. */
function logPluginError(pluginId: string, extId: string, phase: string, err: unknown): void {
  frontendLog(
    "plugin_runtime",
    `Plugin "${pluginId}" ${phase} for "${extId}" threw: ${err instanceof Error ? err.message : String(err)}`
  );
}

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
  refreshWidgetSnapshot();
}

/**
 * Build a {@link TermiHubPluginAPI} instance bound to `pluginId`. Every register
 * call the returned API makes — synchronous top-level, or from a later
 * timer/promise/event callback — is attributed to `pluginId`, so the plugin's
 * registrations are always found and cleanly removed by
 * {@link unregisterPlugin} on disable/uninstall. This replaces the old
 * load-timing attribution, which mis-filed async registrations under the
 * fallback id (#2020).
 */
export function makePluginApi(pluginId: string): TermiHubPluginAPI {
  return {
    registerProtocolParser: (parser) => registerProtocolParserFor(pluginId, parser),
    registerStatusBarWidget: (widget) => registerStatusBarWidgetFor(pluginId, widget),
  };
}

/** The window properties this module installs (extracted for testability). */
type TermiHubGlobals = {
  termihub?: TermiHubPluginAPI;
  __termihubMakePluginApi?: (pluginId: string) => TermiHubPluginAPI;
};

/**
 * Install the frontend-plugin globals on the given target (defaults to the global
 * `window`): the concept-mandated `window.termihub` (a shared fallback instance)
 * and the internal `__termihubMakePluginApi` bridge the loader uses to hand each
 * plugin its own instance. Idempotent: the same objects are reused across calls
 * so a previously-captured reference stays valid. Returns the shared
 * `window.termihub` instance.
 */
export function ensureTermiHubApi(
  target: TermiHubGlobals = window as unknown as TermiHubGlobals
): TermiHubPluginAPI {
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

/** True when at least one protocol parser is registered (pipeline fast-path guard). */
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
 * Apply registered protocol parsers to a raw output chunk in the terminal
 * pipeline. Returns the original bytes untouched when no parser is registered or
 * none transform the chunk (byte-exact pass-through, so unparsed output is never
 * re-encoded), otherwise the UTF-8 encoding of the transformed text.
 */
export function transformOutput(data: Uint8Array, sessionId: string): Uint8Array {
  if (parsers.length === 0) return data;
  const { text, changed } = applyParsers(decoder.decode(data), sessionId);
  return changed ? encoder.encode(text) : data;
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

// ─── Status-bar widget registry ──────────────────────────────────────────────

function refreshWidgetSnapshot(): void {
  const next: Record<WidgetPosition, StatusBarWidgetEntry[]> = { left: [], right: [] };
  for (const { pluginId, widget } of widgets) {
    next[widget.position].push({ key: `${pluginId}:${widget.id}`, widget });
  }
  widgetSnapshot = next;
  for (const listener of widgetListeners) listener();
}

/**
 * Current status-bar widgets for a side, as a stable-reference array suitable
 * for `useSyncExternalStore`. The reference only changes when the registry does.
 */
export function getStatusBarWidgets(position: WidgetPosition): StatusBarWidgetEntry[] {
  return widgetSnapshot[position];
}

/** Subscribe to widget-registry changes; returns an unsubscribe. */
export function subscribeStatusBarWidgets(listener: () => void): () => void {
  widgetListeners.add(listener);
  return () => {
    widgetListeners.delete(listener);
  };
}

// ─── Teardown ────────────────────────────────────────────────────────────────

/**
 * Remove every extension a plugin registered. Called when a plugin is disabled
 * or uninstalled. Parsers are dropped immediately; widgets are dropped from the
 * registry and the resulting snapshot change unmounts their status-bar hosts,
 * which is where `dispose()` runs — so a widget is disposed exactly once, by its
 * React owner.
 */
export function unregisterPlugin(pluginId: string): void {
  parsers = parsers.filter((p) => p.pluginId !== pluginId);
  const before = widgets.length;
  widgets = widgets.filter((w) => w.pluginId !== pluginId);
  if (widgets.length !== before) refreshWidgetSnapshot();
}

/** Drop all registered parsers and widgets (used on teardown / in tests). */
export function clearRegistry(): void {
  parsers = [];
  widgets = [];
  refreshWidgetSnapshot();
}
