/**
 * The frontend-plugin **sandbox worker** — where all frontend plugin JS executes
 * (#2136).
 *
 * This is a classic Web Worker: it has no DOM, no `window`, and no Tauri IPC, so
 * plugin code loaded here cannot reach the host app, the document, or the
 * backend. The worker installs the per-plugin registration API on its own global
 * ({@link ./pluginRuntimeCore.ensureTermiHubApi}), then, for each plugin the host
 * sends, `importScripts` its entry point from the app-controlled `plugin://`
 * origin (the wrapped `/load/<id>/<path>` mode — the protocol serves it already
 * enveloped in the per-plugin loader IIFE, #2020/#2266). Loading from that origin
 * satisfies `script-src` directly, so the worker no longer builds a `blob:` URL
 * and `blob:` could leave `script-src`.
 *
 * All communication is over `postMessage` per {@link ./protocol}:
 * - plugin registrations become `widgetUpsert` / `parsersActive` messages;
 * - `transform` requests run the parser chain and reply `transformResult`;
 * - `sessionStart` / `sessionEnd` fire the parser lifecycle hooks;
 * - `frontendLog` output from plugin code is bridged back as `log` messages so it
 *   still reaches the host's LogViewer.
 */

import { onFrontendLog } from "@/utils/frontendLog";
import {
  ensureTermiHubApi,
  notifySessionEnd,
  notifySessionStart,
  subscribeParsersActive,
  subscribeWidgetEvents,
  transformChunk,
  unregisterPlugin,
} from "./pluginRuntimeCore";
import type { HostToWorkerMessage, TermiHubPluginAPI, WorkerToHostMessage } from "./protocol";

/** The worker global, typed enough to install the plugin API and post messages. */
const ctx = self as unknown as {
  postMessage(message: WorkerToHostMessage, transfer?: Transferable[]): void;
  addEventListener(type: "message", handler: (e: MessageEvent<HostToWorkerMessage>) => void): void;
  termihub?: TermiHubPluginAPI;
  __termihubMakePluginApi?: (pluginId: string) => TermiHubPluginAPI;
};

function post(message: WorkerToHostMessage, transfer?: Transferable[]): void {
  ctx.postMessage(message, transfer);
}

// Install the plugin API + per-plugin bridge on the worker global so wrapped
// plugin sources resolve `self.__termihubMakePluginApi(<id>)`.
ensureTermiHubApi(ctx);

// Relay widget registrations/removals to the host, which owns the real DOM.
subscribeWidgetEvents((event) => {
  if (event.type === "upsert") {
    post({
      t: "widgetUpsert",
      key: event.key,
      position: event.position,
      widgetId: event.widgetId,
      node: event.node,
    });
  } else {
    post({ t: "widgetRemove", key: event.key });
  }
});

// Drive the host's synchronous fast-path guard: it only does a sandbox
// round-trip while at least one parser is registered.
subscribeParsersActive((active) => post({ t: "parsersActive", active }));

// Bridge plugin/runtime debug logs back to the host's LogViewer (log listeners
// in this realm are separate from the main thread's).
onFrontendLog((entry) => post({ t: "log", message: `${entry.target}: ${entry.message}` }));

/**
 * Run a plugin's entry point(s) inside the sandbox by `importScripts`-ing each
 * URL on the app-controlled `plugin://` origin. The protocol serves the wrapped
 * mode (`/load/<id>/<path>`), so the fetched body already carries the per-plugin
 * loader IIFE that binds this plugin's own API instance (#2020/#2266) — no `blob:`
 * URL and no client-side wrapping. Loading from that origin satisfies `script-src`
 * directly. A failed fetch (missing file → the protocol's 404), syntax error, or
 * top-level runtime error is reported to the host, never thrown out of the message
 * handler.
 */
function loadPlugin(pluginId: string, entryUrls: string[]): void {
  for (const url of entryUrls) {
    try {
      (self as unknown as { importScripts(...urls: string[]): void }).importScripts(url);
    } catch (err) {
      post({
        t: "loadError",
        pluginId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

ctx.addEventListener("message", (e: MessageEvent<HostToWorkerMessage>) => {
  const msg = e.data;
  switch (msg.t) {
    case "load":
      loadPlugin(msg.pluginId, msg.entryUrls);
      break;
    case "unload":
      unregisterPlugin(msg.pluginId);
      break;
    case "sessionStart":
      notifySessionStart(msg.sessionId);
      break;
    case "sessionEnd":
      notifySessionEnd(msg.sessionId);
      break;
    case "transform": {
      const result = transformChunk(msg.bytes, msg.sessionId);
      if (result.changed) {
        post({ t: "transformResult", seq: msg.seq, changed: true, bytes: result.bytes }, [
          result.bytes.buffer,
        ]);
      } else {
        post({ t: "transformResult", seq: msg.seq, changed: false });
      }
      break;
    }
  }
});

post({ t: "ready" });
