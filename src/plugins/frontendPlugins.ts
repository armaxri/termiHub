/**
 * Loader for frontend JavaScript plugins — protocol parsers and status-bar
 * widgets (#1998).
 *
 * On plugin activation this reads the plugin's declared JS entry point via the
 * injected file reader (the `read_plugin_file` command in the app), injects it
 * as an inline `<script>` into the WebView, and lets it register extensions
 * through the `window.termihub` API in {@link ./pluginRuntime}. Registrations
 * made while the script runs are attributed to the plugin via
 * {@link setLoadingPlugin} (inline scripts execute synchronously on append, so
 * the attribution window is exactly the append). On deactivation the script is
 * removed and the plugin's registrations are torn down.
 *
 * This mirrors the theme loader's "enumerate active plugins → read declared
 * files → register into a runtime registry" shape (`src/store/appStore.ts` →
 * `loadActivePluginThemes`, `src/themes/pluginThemes.ts`). It stays free of any
 * Tauri import: file reading is injected, keeping the module unit-testable.
 *
 * Concept: `docs/concepts/future/plugin-system.html` (impl §8). Weak isolation
 * (shared WebView context) is accepted per the concept; the Rust-side permission
 * enforcement is tracked separately (#2001).
 */

import type { InstalledPlugin } from "@/types/plugin";
import { ensureTermiHubApi, setLoadingPlugin, unregisterPlugin } from "./pluginRuntime";

/** Injected reader of a plugin file (bytes), relative to `plugins/<id>/`. */
export type PluginFileReader = (pluginId: string, path: string) => Promise<Uint8Array>;

/** Attribute stamped on injected plugin scripts so they can be found and removed. */
const PLUGIN_SCRIPT_ATTR = "data-termihub-plugin";

/** A frontend entry point that failed to load, for surfacing/logging. */
export interface FrontendPluginLoadError {
  pluginId: string;
  entryPoint: string;
  message: string;
}

/** Injected `<script>` elements for a loaded plugin, keyed by plugin id. */
const loadedScripts = new Map<string, HTMLScriptElement[]>();

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
 * Load a single plugin's frontend entry point(s): read each JS file, inject it
 * as an inline `<script>` tagged for later removal, and attribute the register
 * calls it makes to this plugin. A file that fails to read is collected as an
 * error rather than thrown, so one bad plugin never blocks the rest. No-ops when
 * the plugin is already loaded.
 */
export async function loadFrontendPlugin(
  plugin: InstalledPlugin,
  readFile: PluginFileReader,
  doc: Document = document
): Promise<FrontendPluginLoadError[]> {
  const pluginId = plugin.manifest.id;
  if (loadedScripts.has(pluginId)) return [];
  ensureTermiHubApi();

  const scripts: HTMLScriptElement[] = [];
  const errors: FrontendPluginLoadError[] = [];
  for (const entryPoint of frontendEntryPoints(plugin)) {
    try {
      const bytes = await readFile(pluginId, entryPoint);
      const code = new TextDecoder().decode(bytes);
      const script = doc.createElement("script");
      script.type = "text/javascript";
      script.setAttribute(PLUGIN_SCRIPT_ATTR, pluginId);
      script.textContent = code;
      // Inline scripts execute synchronously on append, so bracketing the append
      // with the loading id attributes the plugin's register calls to it.
      setLoadingPlugin(pluginId);
      try {
        (doc.head ?? doc.documentElement).appendChild(script);
      } finally {
        setLoadingPlugin(null);
      }
      scripts.push(script);
    } catch (err) {
      errors.push({
        pluginId,
        entryPoint,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  loadedScripts.set(pluginId, scripts);
  return errors;
}

/**
 * Unload a plugin's frontend extensions: unregister its parsers/widgets (the
 * widget snapshot change disposes their status-bar hosts) and remove its
 * injected `<script>` elements.
 */
export function unloadFrontendPlugin(pluginId: string, doc: Document = document): void {
  unregisterPlugin(pluginId);
  const scripts = loadedScripts.get(pluginId);
  if (scripts) {
    for (const script of scripts) script.parentNode?.removeChild(script);
  }
  // Belt-and-braces: also drop any lingering scripts tagged for this plugin.
  doc
    .querySelectorAll(`script[${PLUGIN_SCRIPT_ATTR}="${pluginId.replace(/"/g, '\\"')}"]`)
    .forEach((el) => el.parentNode?.removeChild(el));
  loadedScripts.delete(pluginId);
}

/**
 * Reconcile the injected frontend plugins against the current plugin list: load
 * every *active* plugin that declares a frontend extension and is not yet
 * loaded, and unload every previously-loaded plugin that is no longer active.
 * Returns any load errors, for logging by the caller. This is the single entry
 * point the store calls on every plugin refresh (install/enable/disable).
 */
export async function reconcileFrontendPlugins(
  plugins: InstalledPlugin[],
  readFile: PluginFileReader,
  doc: Document = document
): Promise<FrontendPluginLoadError[]> {
  ensureTermiHubApi();
  const activeIds = new Set(
    plugins.filter((p) => p.state === "active" && hasFrontendExtension(p)).map((p) => p.manifest.id)
  );

  for (const pluginId of [...loadedScripts.keys()]) {
    if (!activeIds.has(pluginId)) unloadFrontendPlugin(pluginId, doc);
  }

  const errors: FrontendPluginLoadError[] = [];
  for (const plugin of plugins) {
    if (
      plugin.state === "active" &&
      hasFrontendExtension(plugin) &&
      !loadedScripts.has(plugin.manifest.id)
    ) {
      errors.push(...(await loadFrontendPlugin(plugin, readFile, doc)));
    }
  }
  return errors;
}

/** Ids of the plugins whose frontend entry points are currently loaded (testing/introspection). */
export function loadedFrontendPluginIds(): string[] {
  return [...loadedScripts.keys()];
}

/** Forget all loaded-plugin bookkeeping without touching the DOM (tests only). */
export function resetLoadedFrontendPlugins(): void {
  loadedScripts.clear();
}
