/**
 * Tests for the plugin update-check store (PROD-051): recording outcomes and
 * errors per plugin, the stale-outcome rule (an outcome for an older installed
 * version is hidden), and the "update available" predicate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  InstalledPlugin,
  PluginIndexEntryView,
  PluginIndexResult,
  PluginUpdateCheckOutcome,
} from "@/types/plugin";

const checkMock = vi.fn();
const fetchIndexMock = vi.fn();
vi.mock("@/services/api", () => ({
  checkPluginUpdates: (...a: unknown[]) => checkMock(...a),
  fetchPluginIndex: (...a: unknown[]) => fetchIndexMock(...a),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import {
  compareSemver,
  currentEntry,
  currentIndexOffer,
  effectiveUpdate,
  hasAvailableUpdate,
  indexOffersFrom,
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
  usePluginUpdateStore.setState({
    entries: {},
    checkingAll: false,
    lastCheckedAt: null,
    indexOffers: {},
    checkingIndex: false,
    indexError: null,
  });
  checkMock.mockReset();
  fetchIndexMock.mockReset();
  fetchIndexMock.mockResolvedValue(indexResult([]));
});

/** An index entry view for `id` at `version` against installed `installedVersion`. */
function view(
  id: string,
  version: string,
  installedVersion: string | undefined,
  overrides: Partial<PluginIndexEntryView> = {}
): PluginIndexEntryView {
  return {
    entry: {
      id,
      name: id,
      description: "d",
      author: "a",
      version,
      minHostAbi: "1.0",
      native: false,
      packages: [{ platforms: ["any"], url: "https://e/p.zip", sha256: "0".repeat(64) }],
    },
    abiCompatible: true,
    hostAbi: "1.1",
    platformSupported: true,
    hostPlatform: "aarch64-apple-darwin",
    toolchain: "notApplicable",
    installedVersion,
    installStatus: installedVersion === undefined ? "notInstalled" : "updateAvailable",
    installable: true,
    ...overrides,
  };
}

function indexResult(entries: PluginIndexEntryView[]): PluginIndexResult {
  return { url: "https://idx", isDefault: true, entries };
}

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
    expect(fetchIndexMock).toHaveBeenCalledTimes(1);
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
    // A single-plugin check leaves the index alone.
    expect(fetchIndexMock).not.toHaveBeenCalled();
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

describe("pluginUpdateStore — plugin index (#3717)", () => {
  it("records only installable, strictly newer index entries as offers", () => {
    const offers = indexOffersFrom(
      indexResult([
        view("newer", "1.1.0", "1.0.0"),
        view("abi", "2.0.0", "1.0.0", { abiCompatible: false, installable: false }),
        view("platform", "2.0.0", "1.0.0", { platformSupported: false, installable: false }),
        view("toolchain", "2.0.0", "1.0.0", { toolchain: "mismatch", installable: false }),
        view("same", "1.0.0", "1.0.0", { installStatus: "installed", installable: false }),
        view("older", "0.9.0", "1.0.0", { installStatus: "installedNewer", installable: false }),
        view("absent", "1.0.0", undefined),
      ])
    );
    expect(Object.keys(offers)).toEqual(["newer"]);
  });

  it("fetches the index during a check of every plugin", async () => {
    checkMock.mockResolvedValue([]);
    fetchIndexMock.mockResolvedValue(indexResult([view("a", "1.1.0", "1.0.0")]));
    await usePluginUpdateStore.getState().checkForUpdates();
    const state = usePluginUpdateStore.getState();
    expect(Object.keys(state.indexOffers)).toEqual(["a"]);
    expect(state.indexError).toBeNull();
    expect(state.checkingIndex).toBe(false);
    expect(hasAvailableUpdate(state.entries, plugin("a", "1.0.0"), state.indexOffers)).toBe(true);
  });

  it("keeps previous offers and records the error when the index fetch fails", async () => {
    usePluginUpdateStore.setState({ indexOffers: { a: view("a", "1.1.0", "1.0.0") } });
    fetchIndexMock.mockRejectedValue("could not fetch the plugin index: timeout");
    await usePluginUpdateStore.getState().checkIndexForUpdates();
    const state = usePluginUpdateStore.getState();
    expect(state.indexError).toContain("timeout");
    expect(Object.keys(state.indexOffers)).toEqual(["a"]);
  });

  it("records an index fetched by Browse Plugins", () => {
    usePluginUpdateStore.setState({ indexError: "old" });
    usePluginUpdateStore.getState().recordIndex(indexResult([view("a", "1.1.0", "1.0.0")]));
    expect(Object.keys(usePluginUpdateStore.getState().indexOffers)).toEqual(["a"]);
    expect(usePluginUpdateStore.getState().indexError).toBeNull();
  });

  it("hides an index offer computed for an older installed version", () => {
    const offers = { a: view("a", "1.1.0", "1.0.0") };
    expect(currentIndexOffer(offers, plugin("a", "1.0.0"))).toBe(offers.a);
    expect(currentIndexOffer(offers, plugin("a", "1.1.0"))).toBeUndefined();
  });

  it("lets the strictly greater version win, and the updateUrl win ties", () => {
    const own = (latest: string) => ({
      a: { phase: "checked" as const, outcome: outcome("a", "1.0.0", latest, "updateAvailable") },
    });
    const p = plugin("a", "1.0.0", "https://e.com/u.json");

    expect(effectiveUpdate(own("1.1.0"), { a: view("a", "1.2.0", "1.0.0") }, p)).toMatchObject({
      source: "index",
      version: "1.2.0",
    });
    expect(effectiveUpdate(own("1.3.0"), { a: view("a", "1.2.0", "1.0.0") }, p)).toMatchObject({
      source: "updateUrl",
      version: "1.3.0",
    });
    expect(effectiveUpdate(own("1.2.0"), { a: view("a", "1.2.0", "1.0.0") }, p)).toMatchObject({
      source: "updateUrl",
    });
    expect(effectiveUpdate(own("1.2.0"), {}, p)).toMatchObject({ source: "updateUrl" });
    expect(effectiveUpdate({}, { a: view("a", "1.2.0", "1.0.0") }, p)).toMatchObject({
      source: "index",
    });
    expect(effectiveUpdate({}, {}, p)).toBeNull();
  });

  it("offers the index version when the updateUrl has no compatible update", () => {
    const p = plugin("a", "1.0.0", "https://e.com/u.json");
    const entries = {
      a: {
        phase: "checked" as const,
        outcome: outcome("a", "1.0.0", "3.0.0", "incompatibleHost"),
      },
    };
    expect(effectiveUpdate(entries, { a: view("a", "1.2.0", "1.0.0") }, p)).toMatchObject({
      source: "index",
      version: "1.2.0",
    });
  });

  it("compares semver precedence", () => {
    expect(compareSemver("1.2.0", "1.10.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0+build.5")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe(-1);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0", "1.0.0")).toBeNull();
  });
});
