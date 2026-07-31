/**
 * Shared contract between the frontend-plugin sandbox **host** (main thread,
 * {@link ./pluginSandboxHost}) and the sandbox **worker** ({@link
 * ./pluginSandboxWorker}) — part of the plugin sandbox work (#2136).
 *
 * Frontend plugin JS no longer runs in the main WebView document. It runs inside
 * a least-privilege Web Worker with no DOM, no `window`, and no Tauri IPC. The
 * host and worker talk only over `postMessage`, exchanging the structurally
 * cloneable messages defined here. This module is intentionally free of any DOM
 * or Tauri import so it can be shared by both realms and unit-tested in
 * isolation.
 *
 * Two extension points cross the boundary:
 *
 * - **Protocol parsers** transform terminal output. The host posts a chunk
 *   ({@link TransformRequest}); the worker runs the registered parsers and posts
 *   the result ({@link TransformResult}). A per-chunk `seq` preserves per-session
 *   ordering even though the round-trip is asynchronous.
 * - **Status-bar widgets** have no live DOM to hand back across the boundary, so
 *   the worker calls the plugin's `render()` inside the sandbox and posts a
 *   declarative {@link WidgetNode} snapshot ({@link WidgetUpsert}); the host
 *   materialises it into the real status bar (see {@link ./widgetNode}).
 */

import type { WidgetPosition } from "@/types/plugin";

/**
 * A protocol parser a frontend plugin registers via
 * {@link TermiHubPluginAPI.registerProtocolParser} (concept §8). Runs entirely
 * inside the sandbox worker.
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
 *
 * `render()` runs inside the sandbox worker, which has no DOM — so, unlike the
 * pre-sandbox API, it returns a serialisable {@link WidgetNode} descriptor
 * rather than a live `HTMLElement`. The host materialises the descriptor into
 * the real status bar. `dispose()` also runs in the worker, when the plugin is
 * unloaded.
 */
export interface StatusBarWidget {
  /** Widget identifier (unique within the plugin). */
  id: string;
  /** Which side of the status bar the widget renders on. */
  position: WidgetPosition;
  /** Build the widget's declarative DOM description. Called once on mount. */
  render(): WidgetNode;
  /** Tear the widget down. Called when the plugin is disabled/uninstalled. */
  dispose(): void;
}

/**
 * The API surface exposed to frontend plugins (concept §8), installed inside the
 * sandbox worker. Each plugin receives its **own** instance, whose register
 * calls are permanently attributed to that plugin's id — so a registration made
 * from a timer/promise/event callback lands under the right plugin regardless of
 * when it fires, and is cleanly removed on unload (#2020).
 */
export interface TermiHubPluginAPI {
  /** Register a protocol parser (concept §8). */
  registerProtocolParser(parser: ProtocolParser): void;
  /** Register a status-bar widget (concept §8). */
  registerStatusBarWidget(widget: StatusBarWidget): void;
}

/**
 * A serialisable description of a status-bar widget's DOM, produced by a
 * plugin's `render()` inside the worker and materialised on the main thread by
 * {@link ./widgetNode.buildWidgetDom}. Deliberately minimal and declarative:
 * there is no way to express a script, an event handler, or a raw-HTML string,
 * so a hostile descriptor cannot inject executable content into the host page.
 */
export interface WidgetNode {
  /** Element tag name (validated against an allowlist on the host). */
  tag: string;
  /** Text content, set via `textContent` (never `innerHTML`). */
  text?: string;
  /** Attributes, filtered against an allowlist on the host (no `on*`, no urls). */
  attrs?: Record<string, string>;
  /** Nested child descriptors. */
  children?: WidgetNode[];
}

// ─── Messages: host → worker ─────────────────────────────────────────────────

/** Load a plugin's entry point(s) into the sandbox and run them. */
export interface LoadMessage {
  t: "load";
  pluginId: string;
  /**
   * The plugin's entry-point URLs on the app-controlled `plugin://` origin — one
   * per distinct entry point — which the worker `importScripts` in order. Each URL
   * targets the protocol's wrapped mode (`/load/<id>/<path>`), so the served body
   * already carries the per-plugin loader IIFE (#2020/#2266); the worker no longer
   * builds a `blob:` URL, which is what let `blob:` leave `script-src`. A plugin
   * declaring both a parser and a widget from one file yields a single URL; two
   * files yield two, run in order.
   */
  entryUrls: string[];
}

/** Unload a plugin: dispose its widgets and drop its parsers inside the sandbox. */
export interface UnloadMessage {
  t: "unload";
  pluginId: string;
}

/** Notify parsers that a terminal session started. */
export interface SessionStartMessage {
  t: "sessionStart";
  sessionId: string;
}

/** Notify parsers that a terminal session ended. */
export interface SessionEndMessage {
  t: "sessionEnd";
  sessionId: string;
}

/** Ask the sandbox to run the registered parsers over one output chunk. */
export interface TransformRequest {
  t: "transform";
  /** Monotonic per-host sequence number; echoed back to preserve ordering. */
  seq: number;
  sessionId: string;
  /** A copy of the raw output bytes (never transferred — the host keeps the original). */
  bytes: Uint8Array;
}

export type HostToWorkerMessage =
  | LoadMessage
  | UnloadMessage
  | SessionStartMessage
  | SessionEndMessage
  | TransformRequest;

// ─── Messages: worker → host ─────────────────────────────────────────────────

/** Emitted once the worker bootstrap has installed the plugin API and is ready. */
export interface ReadyMessage {
  t: "ready";
}

/**
 * Whether any protocol parser is currently registered. Drives the host's
 * synchronous fast-path guard: when `false`, the terminal pipeline never does a
 * sandbox round-trip.
 */
export interface ParsersActiveMessage {
  t: "parsersActive";
  active: boolean;
}

/** The result of a {@link TransformRequest}, echoing its `seq`. */
export interface TransformResult {
  t: "transformResult";
  seq: number;
  /** True when a parser changed the chunk; then `bytes` carries the new output. */
  changed: boolean;
  /** Present only when `changed` — the UTF-8 encoding of the transformed text. */
  bytes?: Uint8Array;
}

/** A widget was registered (or re-registered): materialise/replace its host DOM. */
export interface WidgetUpsert {
  t: "widgetUpsert";
  /** Collision-proof key `<pluginId>:<widgetId>`. */
  key: string;
  position: WidgetPosition;
  /** Bare widget id (drives the status-bar host `data-testid`). */
  widgetId: string;
  node: WidgetNode;
}

/** A widget was unregistered: unmount its host DOM. */
export interface WidgetRemove {
  t: "widgetRemove";
  key: string;
}

/** A plugin's entry point failed to execute inside the sandbox. */
export interface LoadErrorMessage {
  t: "loadError";
  pluginId: string;
  message: string;
}

/** A debug log line from the sandbox, forwarded to the host's LogViewer. */
export interface LogMessage {
  t: "log";
  message: string;
}

export type WorkerToHostMessage =
  | ReadyMessage
  | ParsersActiveMessage
  | TransformResult
  | WidgetUpsert
  | WidgetRemove
  | LoadErrorMessage
  | LogMessage;

// The per-plugin loader IIFE that used to be built here (`wrapPluginSource`, #2020)
// now lives server-side in the `plugin://` protocol's wrapped mode
// (`src-tauri/src/plugin_protocol.rs`), so the worker can `importScripts` an
// already-wrapped entry point without a `blob:` URL (#2266).
