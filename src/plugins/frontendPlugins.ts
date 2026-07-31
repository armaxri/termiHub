/**
 * Loader for frontend JavaScript plugins — protocol parsers and status-bar
 * widgets (#1998), now executed inside a least-privilege Web Worker sandbox
 * (#2136).
 *
 * On plugin activation this reads the plugin's declared JS entry point(s) via the
 * injected file reader (the `read_plugin_file` command in the app) and hands the
 * source to the sandbox host ({@link ./sandbox/pluginSandboxHost}), which runs it
 * inside a Worker with no DOM, no `window`, and no Tauri IPC. The worker wraps
 * each entry point so the plugin runs against its **own** per-plugin API instance
 * (bound to that plugin's id), so every register call it makes — synchronous or
 * from a later timer/promise/event callback — is attributed to that plugin and
 * cleanly removed on unload (#2020). On deactivation the plugin is unloaded from
 * the sandbox and its registrations are torn down.
 *
 * This mirrors the theme loader's "enumerate active plugins → read declared
 * files → register into a runtime registry" shape (`src/store/appStore.ts` →
 * `loadActivePluginThemes`, `src/themes/pluginThemes.ts`). It stays free of any
 * Tauri import: file reading is injected, keeping the module unit-testable.
 *
 * Concept: `docs/concepts/implemented/plugin-system.html` (§8, §13). Frontend
 * plugin JS runs in a sandbox worker; `blob:` is still used *inside* the worker
 * to run plugin code, and its removal from `script-src` is a tracked follow-up.
 */

import type { InstalledPlugin, PluginFileReader } from "@/types/plugin";
import { loadPluginInSandbox, unloadPluginFromSandbox } from "./sandbox/pluginSandboxHost";

/** A frontend entry point that failed to load, for surfacing/logging. */
export interface FrontendPluginLoadError {
  pluginId: string;
  entryPoint: string;
  message: string;
}

/** Ids of plugins whose frontend entry points are currently loaded in the sandbox. */
const loadedPlugins = new Set<string>();

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
 * Load a single plugin's frontend entry point(s): read each JS file and hand the
 * sources to the sandbox worker to execute. A file that fails to read is
 * collected as an error rather than thrown, so one bad plugin never blocks the
 * rest. No-ops when the plugin is already loaded. When every entry point fails to
 * read, nothing is sent to the sandbox.
 */
export async function loadFrontendPlugin(
  plugin: InstalledPlugin,
  readFile: PluginFileReader
): Promise<FrontendPluginLoadError[]> {
  const pluginId = plugin.manifest.id;
  if (loadedPlugins.has(pluginId)) return [];

  const codes: string[] = [];
  const errors: FrontendPluginLoadError[] = [];
  for (const entryPoint of frontendEntryPoints(plugin)) {
    try {
      const bytes = await readFile(pluginId, entryPoint);
      codes.push(new TextDecoder().decode(bytes));
    } catch (err) {
      errors.push({
        pluginId,
        entryPoint,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (codes.length > 0) {
    loadPluginInSandbox(pluginId, codes);
    loadedPlugins.add(pluginId);
  }
  return errors;
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
 * and unload every previously-loaded plugin that is no longer active. Returns any
 * load errors, for logging by the caller. This is the single entry point the
 * store calls on every plugin refresh (install/enable/disable).
 *
 * `enabled` is the experimental frontend-plugin opt-in (#2048). Frontend plugins
 * execute untrusted JS, so for v0.1.0 their execution is gated behind an
 * explicit, default-off setting. When `enabled` is false this loads nothing and
 * unloads any already-loaded plugin — toggling the setting off therefore tears
 * the sandbox down live.
 */
export async function reconcileFrontendPlugins(
  plugins: InstalledPlugin[],
  readFile: PluginFileReader,
  enabled = true
): Promise<FrontendPluginLoadError[]> {
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

  if (!enabled) return [];

  const errors: FrontendPluginLoadError[] = [];
  for (const plugin of plugins) {
    if (
      plugin.state === "active" &&
      hasFrontendExtension(plugin) &&
      !loadedPlugins.has(plugin.manifest.id)
    ) {
      errors.push(...(await loadFrontendPlugin(plugin, readFile)));
    }
  }
  return errors;
}

/** Ids of the plugins whose frontend entry points are currently loaded (testing/introspection). */
export function loadedFrontendPluginIds(): string[] {
  return [...loadedPlugins];
}

/** Forget all loaded-plugin bookkeeping without touching the sandbox (tests only). */
export function resetLoadedFrontendPlugins(): void {
  loadedPlugins.clear();
}
