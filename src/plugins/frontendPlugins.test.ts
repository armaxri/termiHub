/**
 * Tests for the frontend plugin loader (#1998): reading a plugin's JS entry
 * point, injecting it as a tagged inline `<script>`, unloading (script removal +
 * unregistration), and reconciling the loaded set against the active plugin
 * list.
 *
 * The injected `<script>` runs in the WebView and registers through
 * `window.termihub` in the real app. The vitest jsdom environment evaluates
 * inline scripts in a VM context that does not share `window` with the test
 * module, so these tests use side-effect-free source and assert on the loader's
 * DOM effects and bookkeeping; the registration that a script performs is
 * exercised directly (via `setLoadingPlugin` + `window.termihub`) here and in
 * `pluginRuntime.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InstalledPlugin, PluginState } from "@/types/plugin";
import {
  loadFrontendPlugin,
  unloadFrontendPlugin,
  reconcileFrontendPlugins,
  frontendEntryPoints,
  hasFrontendExtension,
  loadedFrontendPluginIds,
  resetLoadedFrontendPlugins,
} from "./frontendPlugins";
import {
  clearRegistry,
  ensureTermiHubApi,
  makePluginApi,
  getStatusBarWidgets,
  type StatusBarWidget,
} from "./pluginRuntime";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

/** Build an installed plugin with the given frontend extensions. */
function plugin(
  id: string,
  state: PluginState,
  extensions: InstalledPlugin["manifest"]["extensions"]
): InstalledPlugin {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      author: "a",
      description: "d",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["macos"],
      permissions: ["ui"],
      extensions,
    },
    state,
    installedAt: "2026-01-01T00:00:00Z",
  };
}

const parserPlugin = (id: string, state: PluginState = "active", entry = "frontend/index.js") =>
  plugin(id, state, {
    protocolParser: { name: id, description: "d", entryPoint: entry },
  });

/** Side-effect-free valid JS source (a comment) so jsdom's script eval is a no-op. */
const SRC = "/* plugin entry point */";

/** A file reader returning {@link SRC} for any path. */
const reader = () => vi.fn(async () => new TextEncoder().encode(SRC));

/** Register a widget attributed to `pluginId`, as its injected script would. */
function registerWidgetAs(pluginId: string, widget: StatusBarWidget): void {
  makePluginApi(pluginId).registerStatusBarWidget(widget);
}

beforeEach(() => {
  clearRegistry();
  ensureTermiHubApi();
  resetLoadedFrontendPlugins();
  document.head.querySelectorAll("script[data-termihub-plugin]").forEach((s) => s.remove());
});

describe("frontendEntryPoints / hasFrontendExtension", () => {
  it("collects and dedupes entry points across frontend extensions", () => {
    const p = plugin("p", "active", {
      protocolParser: { name: "p", description: "d", entryPoint: "frontend/index.js" },
      statusBarWidget: { entryPoint: "frontend/index.js", position: "left" },
    });
    expect(frontendEntryPoints(p)).toEqual(["frontend/index.js"]);
    expect(hasFrontendExtension(p)).toBe(true);
  });

  it("keeps distinct entry points when a plugin declares two", () => {
    const p = plugin("p", "active", {
      protocolParser: { name: "p", description: "d", entryPoint: "parser.js" },
      statusBarWidget: { entryPoint: "widget.js", position: "right" },
    });
    expect(frontendEntryPoints(p)).toEqual(["parser.js", "widget.js"]);
  });

  it("reports no frontend extension for a theme-only plugin", () => {
    const p = plugin("t", "active", { theme: { themes: [] } });
    expect(hasFrontendExtension(p)).toBe(false);
    expect(frontendEntryPoints(p)).toEqual([]);
  });
});

describe("loadFrontendPlugin", () => {
  it("reads the entry point and injects a tagged inline script", async () => {
    const read = reader();
    const errors = await loadFrontendPlugin(parserPlugin("p"), read);

    expect(errors).toEqual([]);
    expect(read).toHaveBeenCalledWith("p", "frontend/index.js");
    const script = document.head.querySelector<HTMLScriptElement>(
      'script[data-termihub-plugin="p"]'
    );
    expect(script).not.toBeNull();
    // The source is wrapped so the plugin runs against its own per-plugin API
    // instance, bound to its id (#2020) — the original source is preserved inside.
    expect(script?.textContent).toContain(SRC);
    expect(script?.textContent).toContain('window.__termihubMakePluginApi("p")');
    expect(script?.textContent).toMatch(/^\(function \(termihub\) \{/);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);
  });

  it("does not re-inject an already-loaded plugin", async () => {
    const read = reader();
    await loadFrontendPlugin(parserPlugin("p"), read);
    await loadFrontendPlugin(parserPlugin("p"), read);
    expect(document.head.querySelectorAll('script[data-termihub-plugin="p"]')).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("collects a read failure as an error rather than throwing", async () => {
    const read = vi.fn(async () => {
      throw new Error("no such file");
    });
    const errors = await loadFrontendPlugin(parserPlugin("p"), read);
    expect(errors).toEqual([
      { pluginId: "p", entryPoint: "frontend/index.js", message: "no such file" },
    ]);
  });

  it("injects one script per distinct entry point", async () => {
    const p = plugin("p", "active", {
      protocolParser: { name: "p", description: "d", entryPoint: "parser.js" },
      statusBarWidget: { entryPoint: "widget.js", position: "right" },
    });
    await loadFrontendPlugin(p, reader());
    expect(document.head.querySelectorAll('script[data-termihub-plugin="p"]')).toHaveLength(2);
  });
});

describe("unloadFrontendPlugin", () => {
  it("removes injected scripts and unregisters the plugin's widgets", async () => {
    await loadFrontendPlugin(parserPlugin("p"), reader());
    // Simulate the widget the plugin's entry point would have registered.
    registerWidgetAs("p", {
      id: "w",
      position: "left",
      render: () => document.createElement("span"),
      dispose: () => {},
    });
    expect(getStatusBarWidgets("left")).toHaveLength(1);

    unloadFrontendPlugin("p");

    expect(document.head.querySelectorAll('script[data-termihub-plugin="p"]')).toHaveLength(0);
    expect(getStatusBarWidgets("left")).toHaveLength(0);
    expect(loadedFrontendPluginIds()).toEqual([]);
  });
});

describe("reconcileFrontendPlugins", () => {
  it("loads active frontend plugins and skips inactive / theme-only ones", async () => {
    const plugins = [
      parserPlugin("active-parser", "active"),
      parserPlugin("disabled-parser", "disabled"),
      plugin("theme-only", "active", { theme: { themes: [] } }),
    ];
    await reconcileFrontendPlugins(plugins, reader());
    expect(loadedFrontendPluginIds()).toEqual(["active-parser"]);
  });

  it("unloads a plugin that is no longer active", async () => {
    await reconcileFrontendPlugins([parserPlugin("p", "active")], reader());
    expect(loadedFrontendPluginIds()).toEqual(["p"]);

    await reconcileFrontendPlugins([parserPlugin("p", "disabled")], reader());
    expect(loadedFrontendPluginIds()).toEqual([]);
    expect(document.head.querySelectorAll('script[data-termihub-plugin="p"]')).toHaveLength(0);
  });

  it("is idempotent across repeated reconciles of the same set", async () => {
    const plugins = [parserPlugin("p", "active")];
    const read = reader();
    await reconcileFrontendPlugins(plugins, read);
    await reconcileFrontendPlugins(plugins, read);
    expect(document.head.querySelectorAll('script[data-termihub-plugin="p"]')).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
