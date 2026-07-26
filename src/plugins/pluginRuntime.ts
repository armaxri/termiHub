/**
 * Frontend JavaScript plugin runtime — the `window.termihub` registration
 * surface and the registries it feeds (#1998).
 *
 * A frontend plugin is a plain JavaScript file the plugin author ships at
 * `frontend/index.js` (the `entryPoint` its `protocolParser` / `statusBarWidget`
 * extension declares). On activation the loader in {@link ./frontendPlugins}
 * injects that script into the WebView; the script calls the API exposed here on
 * `window.termihub` to register two kinds of extension:
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

/** The API surface exposed to frontend plugins on `window.termihub`. */
export interface TermiHubPluginAPI {
  /** Register a protocol parser (concept §8). */
  registerProtocolParser(parser: ProtocolParser): void;
  /** Register a status-bar widget (concept §8). */
  registerStatusBarWidget(widget: StatusBarWidget): void;
}

declare global {
  interface Window {
    /** The frontend-plugin registration API (#1998). Present once a plugin has loaded. */
    termihub: TermiHubPluginAPI;
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
 * The plugin id currently being loaded, set by the loader around the synchronous
 * `<script>` injection so register calls made while a plugin's entry point runs
 * are attributed to it. `null` outside a load (a stray register call then lands
 * under `"unknown"`).
 */
let loadingPluginId: string | null = null;

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

/**
 * Set (or clear) the plugin id that subsequent register calls are attributed to.
 * Called by the loader immediately around the synchronous script injection.
 */
export function setLoadingPlugin(pluginId: string | null): void {
  loadingPluginId = pluginId;
}

function registerProtocolParser(parser: ProtocolParser): void {
  const pluginId = loadingPluginId ?? "unknown";
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

function registerStatusBarWidget(widget: StatusBarWidget): void {
  const pluginId = loadingPluginId ?? "unknown";
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
 * Install the `window.termihub` API on the given target (defaults to the global
 * `window`). Idempotent: the same API object is reused across calls so a
 * previously-loaded plugin's captured reference stays valid.
 */
export function ensureTermiHubApi(
  target: { termihub?: TermiHubPluginAPI } = window as unknown as {
    termihub?: TermiHubPluginAPI;
  }
): TermiHubPluginAPI {
  if (!target.termihub) {
    target.termihub = {
      registerProtocolParser,
      registerStatusBarWidget,
    };
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

/** Notify every parser's optional `onSessionStart` hook (errors isolated). */
export function notifySessionStart(sessionId: string): void {
  for (const { pluginId, parser } of parsers) {
    if (!parser.onSessionStart) continue;
    try {
      parser.onSessionStart(sessionId);
    } catch (err) {
      logPluginError(pluginId, parser.id, "onSessionStart", err);
    }
  }
}

/** Notify every parser's optional `onSessionEnd` hook (errors isolated). */
export function notifySessionEnd(sessionId: string): void {
  for (const { pluginId, parser } of parsers) {
    if (!parser.onSessionEnd) continue;
    try {
      parser.onSessionEnd(sessionId);
    } catch (err) {
      logPluginError(pluginId, parser.id, "onSessionEnd", err);
    }
  }
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
  loadingPluginId = null;
  refreshWidgetSnapshot();
}
