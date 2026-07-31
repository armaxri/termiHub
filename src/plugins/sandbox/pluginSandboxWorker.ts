/**
 * The frontend-plugin **sandbox worker** — where all frontend plugin JS executes
 * (#2136).
 *
 * This is a classic Web Worker: it has no DOM, no `window`, and no Tauri IPC, so
 * plugin code loaded here cannot reach the host app, the document, or the
 * backend. The worker installs the per-plugin registration API on its own global
 * ({@link ./pluginRuntimeCore.ensureTermiHubApi}), then, for each plugin the host
 * sends, wraps the entry-point source and runs it via a `blob:`-URL
 * `importScripts` — the same CSP-compatible mechanism (`script-src 'self'
 * blob:`) the old main-document loader used, now confined to the worker.
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
import { wrapPluginSource } from "./protocol";
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
 * Run a plugin's entry point inside the sandbox. The source is wrapped so it
 * receives its own per-plugin API instance (#2020) and loaded from a blob URL —
 * creating the URL already requires script execution, so it is not an injection
 * vector, and `script-src 'self' blob:` runs it under the enforced CSP. A syntax
 * or top-level runtime error is reported to the host, never thrown out of the
 * message handler.
 */
function loadPlugin(pluginId: string, codes: string[]): void {
  for (const code of codes) {
    const wrapped = wrapPluginSource(pluginId, code);
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([wrapped], { type: "text/javascript" }));
      (self as unknown as { importScripts(...urls: string[]): void }).importScripts(url);
    } catch (err) {
      post({
        t: "loadError",
        pluginId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
}

ctx.addEventListener("message", (e: MessageEvent<HostToWorkerMessage>) => {
  const msg = e.data;
  switch (msg.t) {
    case "load":
      loadPlugin(msg.pluginId, msg.codes);
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
