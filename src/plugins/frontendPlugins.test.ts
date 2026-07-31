/**
 * Tests for the frontend plugin loader (#1998, sandboxed #2136, plugin:// loader
 * #2266): resolving a plugin's JS entry point(s) to `plugin://` URLs, handing them
 * to the sandbox host, unloading, and reconciling the loaded set against the
 * active plugin list. Plugin code no longer runs in the main document — it runs in
 * the sandbox worker, which `importScripts` the entry-point URLs — so these tests
 * mock the sandbox host and assert the loader drives it with the right URLs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { InstalledPlugin, PluginState } from "@/types/plugin";

const loadPluginInSandbox = vi.fn();
const unloadPluginFromSandbox = vi.fn();
vi.mock("./sandbox/pluginSandboxHost", () => ({
  loadPluginInSandbox: (...args: unknown[]) => loadPluginInSandbox(...args),
  unloadPluginFromSandbox: (...args: unknown[]) => unloadPluginFromSandbox(...args),
}));

import {
  loadFrontendPlugin,
  unloadFrontendPlugin,
  reconcileFrontendPlugins,
  frontendEntryPoints,
  hasFrontendExtension,
  loadedFrontendPluginIds,
  resetLoadedFrontendPlugins,
  pluginEntryUrl,
} from "./frontendPlugins";

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

/** The `plugin://` URL the loader builds for an entry point on non-Windows. */
const url = (id: string, entry: string) => `plugin://localhost/load/${id}/${entry}`;

beforeEach(() => {
  resetLoadedFrontendPlugins();
  loadPluginInSandbox.mockClear();
  unloadPluginFromSandbox.mockClear();
});

describe("pluginEntryUrl", () => {
  it("builds a wrapped-mode plugin:// URL with literal path separators", () => {
    // jsdom's user agent is not Windows, so the custom-scheme form is used.
    expect(pluginEntryUrl("p", "frontend/index.js")).toBe(
      "plugin://localhost/load/p/frontend/index.js"
    );
  });

  it("URI-encodes each path segment but keeps the separators literal", () => {
    expect(pluginEntryUrl("my-plugin", "front end/main file.js")).toBe(
      "plugin://localhost/load/my-plugin/front%20end/main%20file.js"
    );
  });
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
  it("resolves the entry point to its plugin:// URL and loads it into the sandbox", () => {
    loadFrontendPlugin(parserPlugin("p"));

    expect(loadPluginInSandbox).toHaveBeenCalledWith("p", [url("p", "frontend/index.js")]);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);
  });

  it("does not re-load an already-loaded plugin", () => {
    loadFrontendPlugin(parserPlugin("p"));
    loadFrontendPlugin(parserPlugin("p"));
    expect(loadPluginInSandbox).toHaveBeenCalledTimes(1);
  });

  it("does not touch the sandbox for a plugin with no frontend entry point", () => {
    loadFrontendPlugin(plugin("t", "active", { theme: { themes: [] } }));
    expect(loadPluginInSandbox).not.toHaveBeenCalled();
    expect(loadedFrontendPluginIds()).toEqual([]);
  });

  it("passes one URL per distinct entry point", () => {
    const p = plugin("p", "active", {
      protocolParser: { name: "p", description: "d", entryPoint: "parser.js" },
      statusBarWidget: { entryPoint: "widget.js", position: "right" },
    });
    loadFrontendPlugin(p);
    expect(loadPluginInSandbox).toHaveBeenCalledWith("p", [
      url("p", "parser.js"),
      url("p", "widget.js"),
    ]);
  });
});

describe("unloadFrontendPlugin", () => {
  it("unloads the plugin from the sandbox and forgets it", () => {
    loadFrontendPlugin(parserPlugin("p"));
    unloadFrontendPlugin("p");
    expect(unloadPluginFromSandbox).toHaveBeenCalledWith("p");
    expect(loadedFrontendPluginIds()).toEqual([]);
  });

  it("is a no-op for a plugin that is not loaded", () => {
    unloadFrontendPlugin("nope");
    expect(unloadPluginFromSandbox).not.toHaveBeenCalled();
  });
});

describe("reconcileFrontendPlugins", () => {
  it("loads active frontend plugins and skips inactive / theme-only ones", () => {
    const plugins = [
      parserPlugin("active-parser", "active"),
      parserPlugin("disabled-parser", "disabled"),
      plugin("theme-only", "active", { theme: { themes: [] } }),
    ];
    reconcileFrontendPlugins(plugins);
    expect(loadedFrontendPluginIds()).toEqual(["active-parser"]);
  });

  it("unloads a plugin that is no longer active", () => {
    reconcileFrontendPlugins([parserPlugin("p", "active")]);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);

    reconcileFrontendPlugins([parserPlugin("p", "disabled")]);
    expect(loadedFrontendPluginIds()).toEqual([]);
    expect(unloadPluginFromSandbox).toHaveBeenCalledWith("p");
  });

  it("is idempotent across repeated reconciles of the same set", () => {
    const plugins = [parserPlugin("p", "active")];
    reconcileFrontendPlugins(plugins);
    reconcileFrontendPlugins(plugins);
    expect(loadPluginInSandbox).toHaveBeenCalledTimes(1);
  });

  // Experimental frontend-plugin gate (#2048): the default-off opt-in.
  it("loads nothing when the experimental gate is disabled", () => {
    reconcileFrontendPlugins([parserPlugin("p", "active")], false);
    expect(loadedFrontendPluginIds()).toEqual([]);
    expect(loadPluginInSandbox).not.toHaveBeenCalled();
  });

  it("unloads already-loaded plugins when the gate is toggled off", () => {
    reconcileFrontendPlugins([parserPlugin("p", "active")], true);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);

    reconcileFrontendPlugins([parserPlugin("p", "active")], false);
    expect(loadedFrontendPluginIds()).toEqual([]);
    expect(unloadPluginFromSandbox).toHaveBeenCalledWith("p");
  });

  it("loads active plugins again when the gate is toggled back on", () => {
    const plugins = [parserPlugin("p", "active")];
    reconcileFrontendPlugins(plugins, false);
    expect(loadedFrontendPluginIds()).toEqual([]);

    reconcileFrontendPlugins(plugins, true);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);
  });
});
