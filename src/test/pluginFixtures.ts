import type { InstalledPlugin, PluginState } from "@/types/plugin";

/**
 * An installed native plugin providing the terminal-backend connection type
 * `connectionType`, in `state` — for tests of plugin-dependent connection UI
 * (#3344).
 */
export function backendPlugin(
  id: string,
  connectionType: string,
  state: PluginState = "active",
  name = id
): InstalledPlugin {
  return {
    manifest: {
      id,
      name,
      version: "1.0.0",
      author: "tester",
      description: "test plugin",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["linux", "macos", "windows"],
      permissions: ["terminal"],
      extensions: {
        terminalBackend: { connectionType, displayName: connectionType, configSchema: {} },
      },
    },
    state,
    installedAt: "2026-01-01T00:00:00Z",
  };
}
