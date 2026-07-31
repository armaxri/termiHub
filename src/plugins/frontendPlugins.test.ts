/**
 * Tests for the frontend plugin loader (#1998, sandboxed #2136): reading a
 * plugin's JS entry point(s), handing the source to the sandbox host, unloading,
 * and reconciling the loaded set against the active plugin list. Plugin code no
 * longer runs in the main document — it runs in the sandbox worker — so these
 * tests mock the sandbox host and assert the loader drives it correctly.
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

const SRC = "/* plugin entry point */";

/** A file reader returning {@link SRC} for any path. */
const reader = () => vi.fn(async () => new TextEncoder().encode(SRC));

beforeEach(() => {
  resetLoadedFrontendPlugins();
  loadPluginInSandbox.mockClear();
  unloadPluginFromSandbox.mockClear();
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
  it("reads the entry point and loads its source into the sandbox", async () => {
    const read = reader();
    const errors = await loadFrontendPlugin(parserPlugin("p"), read);

    expect(errors).toEqual([]);
    expect(read).toHaveBeenCalledWith("p", "frontend/index.js");
    expect(loadPluginInSandbox).toHaveBeenCalledWith("p", [SRC]);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);
  });

  it("does not re-load an already-loaded plugin", async () => {
    const read = reader();
    await loadFrontendPlugin(parserPlugin("p"), read);
    await loadFrontendPlugin(parserPlugin("p"), read);
    expect(loadPluginInSandbox).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("collects a read failure as an error and does not load", async () => {
    const read = vi.fn(async () => {
      throw new Error("no such file");
    });
    const errors = await loadFrontendPlugin(parserPlugin("p"), read);
    expect(errors).toEqual([
      { pluginId: "p", entryPoint: "frontend/index.js", message: "no such file" },
    ]);
    expect(loadPluginInSandbox).not.toHaveBeenCalled();
    expect(loadedFrontendPluginIds()).toEqual([]);
  });

  it("passes one source per distinct entry point", async () => {
    const p = plugin("p", "active", {
      protocolParser: { name: "p", description: "d", entryPoint: "parser.js" },
      statusBarWidget: { entryPoint: "widget.js", position: "right" },
    });
    await loadFrontendPlugin(p, reader());
    expect(loadPluginInSandbox).toHaveBeenCalledWith("p", [SRC, SRC]);
  });
});

describe("unloadFrontendPlugin", () => {
  it("unloads the plugin from the sandbox and forgets it", async () => {
    await loadFrontendPlugin(parserPlugin("p"), reader());
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
    expect(unloadPluginFromSandbox).toHaveBeenCalledWith("p");
  });

  it("is idempotent across repeated reconciles of the same set", async () => {
    const plugins = [parserPlugin("p", "active")];
    const read = reader();
    await reconcileFrontendPlugins(plugins, read);
    await reconcileFrontendPlugins(plugins, read);
    expect(loadPluginInSandbox).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  // Experimental frontend-plugin gate (#2048): the default-off opt-in.
  it("loads nothing when the experimental gate is disabled", async () => {
    const read = reader();
    const errors = await reconcileFrontendPlugins([parserPlugin("p", "active")], read, false);
    expect(errors).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(loadedFrontendPluginIds()).toEqual([]);
    expect(loadPluginInSandbox).not.toHaveBeenCalled();
  });

  it("unloads already-loaded plugins when the gate is toggled off", async () => {
    const read = reader();
    await reconcileFrontendPlugins([parserPlugin("p", "active")], read, true);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);

    await reconcileFrontendPlugins([parserPlugin("p", "active")], read, false);
    expect(loadedFrontendPluginIds()).toEqual([]);
    expect(unloadPluginFromSandbox).toHaveBeenCalledWith("p");
  });

  it("loads active plugins again when the gate is toggled back on", async () => {
    const plugins = [parserPlugin("p", "active")];
    const read = reader();
    await reconcileFrontendPlugins(plugins, read, false);
    expect(loadedFrontendPluginIds()).toEqual([]);

    await reconcileFrontendPlugins(plugins, read, true);
    expect(loadedFrontendPluginIds()).toEqual(["p"]);
  });
});
