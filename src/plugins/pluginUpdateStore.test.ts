/**
 * Tests for the plugin update-check store (PROD-051): recording outcomes and
 * errors per plugin, the stale-outcome rule (an outcome for an older installed
 * version is hidden), and the "update available" predicate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, PluginUpdateCheckOutcome } from "@/types/plugin";

const checkMock = vi.fn();
vi.mock("@/services/api", () => ({
  checkPluginUpdates: (...a: unknown[]) => checkMock(...a),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import {
  currentEntry,
  hasAvailableUpdate,
  hasUpdateSource,
  usePluginUpdateStore,
} from "./pluginUpdateStore";

function plugin(id: string, version: string, updateUrl?: string): InstalledPlugin {
  return {
    manifest: {
      id,
      name: id,
      version,
      author: "a",
      description: "d",
      license: "MIT",
      apiVersion: "1.0",
      platforms: ["linux"],
      permissions: [],
      extensions: { theme: { themes: [] } },
      updateUrl,
    },
    state: "active",
    installedAt: "2026-01-01T00:00:00Z",
  } as InstalledPlugin;
}

function outcome(
  pluginId: string,
  installedVersion: string,
  latestVersion: string,
  status: PluginUpdateCheckOutcome["status"]
): PluginUpdateCheckOutcome {
  return {
    pluginId,
    installedVersion,
    latestVersion,
    status,
    downloadUrl: "https://example.com/p.termihub-plugin",
    sha256: "0".repeat(64),
    minHostAbi: "1.0",
  };
}

beforeEach(() => {
  usePluginUpdateStore.setState({ entries: {}, checkingAll: false, lastCheckedAt: null });
  checkMock.mockReset();
});

describe("pluginUpdateStore", () => {
  it("records outcomes and errors from a check of every plugin", async () => {
    checkMock.mockResolvedValue([
      { pluginId: "a", outcome: outcome("a", "1.0.0", "1.1.0", "updateAvailable") },
      { pluginId: "b", error: "update document is malformed" },
    ]);
    const pending = usePluginUpdateStore.getState().checkForUpdates();
    expect(usePluginUpdateStore.getState().checkingAll).toBe(true);
    await pending;

    expect(checkMock).toHaveBeenCalledWith(undefined);
    const { entries, checkingAll, lastCheckedAt } = usePluginUpdateStore.getState();
    expect(checkingAll).toBe(false);
    expect(lastCheckedAt).not.toBeNull();
    expect(entries.a).toMatchObject({ phase: "checked", outcome: { latestVersion: "1.1.0" } });
    expect(entries.b).toEqual({ phase: "error", error: "update document is malformed" });
  });

  it("marks a single plugin as checking, then records its result", async () => {
    let resolve: (v: unknown) => void = () => {};
    checkMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = usePluginUpdateStore.getState().checkForUpdates(["a"]);
    expect(usePluginUpdateStore.getState().entries.a).toEqual({ phase: "checking" });
    expect(usePluginUpdateStore.getState().checkingAll).toBe(false);

    resolve([{ pluginId: "a", outcome: outcome("a", "1.0.0", "1.0.0", "upToDate") }]);
    await pending;
    expect(checkMock).toHaveBeenCalledWith("a");
    expect(usePluginUpdateStore.getState().entries.a).toMatchObject({ phase: "checked" });
    expect(usePluginUpdateStore.getState().lastCheckedAt).toBeNull();
  });

  it("records a rejected check as an error for the requested plugins", async () => {
    checkMock.mockRejectedValue(new Error("offline"));
    await usePluginUpdateStore.getState().checkForUpdates(["a"]);
    expect(usePluginUpdateStore.getState().entries.a).toEqual({ phase: "error", error: "offline" });
  });

  it("hides an outcome computed for an older installed version", () => {
    const entries = {
      a: { phase: "checked" as const, outcome: outcome("a", "1.0.0", "1.1.0", "updateAvailable") },
    };
    expect(currentEntry(entries, plugin("a", "1.0.0"))).toBe(entries.a);
    expect(hasAvailableUpdate(entries, plugin("a", "1.0.0"))).toBe(true);
    // The plugin has since been updated to 1.1.0: the old outcome is stale.
    expect(currentEntry(entries, plugin("a", "1.1.0"))).toBeUndefined();
    expect(hasAvailableUpdate(entries, plugin("a", "1.1.0"))).toBe(false);
  });

  it("only reports an update for the updateAvailable status", () => {
    for (const status of ["upToDate", "incompatibleHost"] as const) {
      const entries = {
        a: { phase: "checked" as const, outcome: outcome("a", "1.0.0", "2.0.0", status) },
      };
      expect(hasAvailableUpdate(entries, plugin("a", "1.0.0"))).toBe(false);
    }
  });

  it("detects plugins that declare an update source", () => {
    expect(hasUpdateSource(plugin("a", "1.0.0", "https://e.com/u.json"))).toBe(true);
    expect(hasUpdateSource(plugin("a", "1.0.0"))).toBe(false);
    expect(hasUpdateSource(plugin("a", "1.0.0", ""))).toBe(false);
  });
});
