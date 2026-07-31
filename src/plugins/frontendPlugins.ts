/**
 * Loader for frontend JavaScript plugins — protocol parsers and status-bar
 * widgets (#1998), now executed inside a least-privilege Web Worker sandbox
 * (#2136).
 *
 * On plugin activation this hands the plugin's declared JS entry point(s) — as
 * URLs on the app-controlled `plugin://` origin — to the sandbox host ({@link
 * ./sandbox/pluginSandboxHost}), which `importScripts` them inside a Worker with
 * no DOM, no `window`, and no Tauri IPC. The protocol serves those URLs in its
 * wrapped mode, so each entry point arrives already enveloped in the per-plugin
 * loader IIFE bound to that plugin's id — every register call it makes,
 * synchronous or from a later timer/promise/event callback, is attributed to that
 * plugin and cleanly removed on unload (#2020). On deactivation the plugin is
 * unloaded from the sandbox and its registrations are torn down.
 *
 * The switch to `plugin://` (#2266) means this module no longer reads plugin files
 * into strings: the bytes never touch the main thread, and — crucially — loading
 * from the `plugin://` origin satisfies `script-src` directly, which is what let
 * `blob:` leave `script-src`. A file that cannot be read now surfaces as an
 * `importScripts` failure inside the worker (reported back as a `loadError`),
 * rather than a read rejection here.
 *
 * Concept: `docs/concepts/implemented/plugin-system.html` (§8, §13).
 */

import type { InstalledPlugin } from "@/types/plugin";
import { isWindows } from "@/utils/platform";
import { loadPluginInSandbox, unloadPluginFromSandbox } from "./sandbox/pluginSandboxHost";

/** Ids of plugins whose frontend entry points are currently loaded in the sandbox. */
const loadedPlugins = new Set<string>();

/**
 * Build the `plugin://` URL for a plugin's entry point, in the protocol's wrapped
 * mode (`/load/<id>/<path>`). The origin form is platform-specific: `plugin://`
 * (a custom scheme) on macOS/Linux, `http://plugin.localhost` on Windows — the two
 * forms Tauri assigns and both listed in `script-src`. Each path segment is
 * URI-encoded but the separators stay literal `/`, matching how the Rust handler
 * splits the request path (#2251/#2266).
 */
export function pluginEntryUrl(pluginId: string, entryPoint: string): string {
  const origin = isWindows() ? "http://plugin.localhost" : "plugin://localhost";
  const id = encodeURIComponent(pluginId);
  const path = entryPoint.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${origin}/load/${id}/${path}`;
}

/**
 * The distinct JS entry points a plugin declares across its frontend extensions
 * (`protocolParser.entryPoint` and `statusBarWidget.entryPoint`). Usually a
 * single `frontend/index.js`; deduped so one shared entry point loads once even
 * when a plugin provides both a parser and a widget.
 */
export function frontendEntryPoints(plugin: InstalledPlugin): string[] {
  const ext = plugin.manifest.extensions;
  const points = new Set<string>();
  if (ext.protocolParser?.entryPoint) points.add(ext.protocolParser.entryPoint);
  if (ext.statusBarWidget?.entryPoint) points.add(ext.statusBarWidget.entryPoint);
  return [...points];
}

/** True when a plugin declares any frontend (JS) extension point. */
export function hasFrontendExtension(plugin: InstalledPlugin): boolean {
  return frontendEntryPoints(plugin).length > 0;
}

/**
 * Load a single plugin's frontend entry point(s): resolve each declared entry
 * point to its `plugin://` URL and hand them to the sandbox worker to
 * `importScripts` and execute. No-ops when the plugin is already loaded or
 * declares no frontend entry point. A file that cannot be read no longer fails
 * here — it surfaces as a `loadError` from the worker (the protocol returns 404
 * and `importScripts` throws), so one bad plugin never blocks the rest.
 */
export function loadFrontendPlugin(plugin: InstalledPlugin): void {
  const pluginId = plugin.manifest.id;
  if (loadedPlugins.has(pluginId)) return;

  const entryUrls = frontendEntryPoints(plugin).map((entryPoint) =>
    pluginEntryUrl(pluginId, entryPoint)
  );
  if (entryUrls.length > 0) {
    loadPluginInSandbox(pluginId, entryUrls);
    loadedPlugins.add(pluginId);
  }
}

/**
 * Unload a plugin's frontend extensions: tell the sandbox to dispose its
 * widgets and drop its parsers. No-ops when the plugin is not loaded.
 */
export function unloadFrontendPlugin(pluginId: string): void {
  if (!loadedPlugins.has(pluginId)) return;
  unloadPluginFromSandbox(pluginId);
  loadedPlugins.delete(pluginId);
}

/**
 * Reconcile the sandboxed frontend plugins against the current plugin list: load
 * every *active* plugin that declares a frontend extension and is not yet loaded,
 * and unload every previously-loaded plugin that is no longer active. This is the
 * single entry point the store calls on every plugin refresh
 * (install/enable/disable).
 *
 * `enabled` is the experimental frontend-plugin opt-in (#2048). Frontend plugins
 * execute untrusted JS, so for v0.1.0 their execution is gated behind an
 * explicit, default-off setting. When `enabled` is false this loads nothing and
 * unloads any already-loaded plugin — toggling the setting off therefore tears
 * the sandbox down live.
 */
export function reconcileFrontendPlugins(plugins: InstalledPlugin[], enabled = true): void {
  const activeIds = new Set(
    enabled
      ? plugins
          .filter((p) => p.state === "active" && hasFrontendExtension(p))
          .map((p) => p.manifest.id)
      : []
  );

  for (const pluginId of [...loadedPlugins]) {
    if (!activeIds.has(pluginId)) unloadFrontendPlugin(pluginId);
  }

  if (!enabled) return;

  for (const plugin of plugins) {
    if (
      plugin.state === "active" &&
      hasFrontendExtension(plugin) &&
      !loadedPlugins.has(plugin.manifest.id)
    ) {
      loadFrontendPlugin(plugin);
    }
  }
}

/** Ids of the plugins whose frontend entry points are currently loaded (testing/introspection). */
export function loadedFrontendPluginIds(): string[] {
  return [...loadedPlugins];
}

/** Forget all loaded-plugin bookkeeping without touching the sandbox (tests only). */
export function resetLoadedFrontendPlugins(): void {
  loadedPlugins.clear();
}
