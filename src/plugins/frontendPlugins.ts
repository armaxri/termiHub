/**
 * Loader for frontend JavaScript plugins — protocol parsers and status-bar
 * widgets (#1998).
 *
 * On plugin activation this reads the plugin's declared JS entry point via the
 * injected file reader (the `read_plugin_file` command in the app), injects it
 * as an inline `<script>` into the WebView, and lets it register extensions
 * through the {@link ./pluginRuntime} API. Each script is wrapped so the plugin
 * runs against its **own** {@link makePluginApi} instance (bound to the plugin
 * id) passed in as `termihub` — so every register call it makes, synchronous or
 * from a later timer/promise/event callback, is attributed to that plugin and
 * cleanly removed on unload (#2020). On deactivation the script is removed and
 * the plugin's registrations are torn down.
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

import type { InstalledPlugin, PluginFileReader } from "@/types/plugin";
import { ensureTermiHubApi, unregisterPlugin } from "./pluginRuntime";

/** Attribute stamped on injected plugin scripts so they can be found and removed. */
const PLUGIN_SCRIPT_ATTR = "data-termihub-plugin";

/**
 * Wrap a plugin's entry-point source so it runs against its own per-plugin API
 * instance. The plugin body executes inside a function whose `termihub`
 * parameter is the instance {@link makePluginApi} builds for `pluginId` (via the
 * `__termihubMakePluginApi` bridge {@link ensureTermiHubApi} installs on the
 * page). That local `termihub` shadows the shared `window.termihub`, so every
 * register call — synchronous or from a later timer/promise/event callback — is
 * attributed to this plugin regardless of load timing (#2020). The plugin id is
 * JSON-encoded, so it is safely quoted into the wrapper.
 *
 * The bridge lookup falls back to the shared `window.termihub` if the bridge is
 * somehow absent, so evaluating the wrapper can never throw before the plugin
 * body runs (`ensureTermiHubApi` always installs it first in production; the
 * fallback also keeps the isolated jsdom script context used in tests inert).
 */
function wrapPluginSource(pluginId: string, code: string): string {
  const api = `(window.__termihubMakePluginApi ? window.__termihubMakePluginApi(${JSON.stringify(
    pluginId
  )}) : window.termihub)`;
  return `(function (termihub) {\n${code}\n})(${api});`;
}

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
      // Wrap so the plugin registers against its own per-plugin API instance,
      // making attribution independent of when register is called (#2020).
      script.textContent = wrapPluginSource(pluginId, code);
      (doc.head ?? doc.documentElement).appendChild(script);
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
 * injected `<script>` elements. The tracked script list is authoritative — it
 * holds exactly the elements this loader appended — so detaching each is enough.
 */
export function unloadFrontendPlugin(pluginId: string): void {
  unregisterPlugin(pluginId);
  const scripts = loadedScripts.get(pluginId);
  if (scripts) {
    for (const script of scripts) script.parentNode?.removeChild(script);
  }
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
    if (!activeIds.has(pluginId)) unloadFrontendPlugin(pluginId);
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
