/**
 * Settings bridge — the authoritative-region plumbing (#2227). Covers the pieces
 * the reader hook and mutation path depend on: the default view before any diff,
 * the version guard that ignores a stale (late-delivered) snapshot, and the
 * reliable `seedSettingsRegion` dispatch that resolves on accept and rejects on a
 * rejected ack or transport failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Intent, IntentAck, Transport } from "@/services/transport";
import {
  installSettingsHarness,
  settingsDoc,
  FakeSettingsTransport,
} from "@/test/settingsRegionTestHarness";

import {
  currentSettingsView,
  DEFAULT_SETTINGS_VIEW,
  ensureSettingsSubscribed,
  onSettingsView,
  seedSettingsRegion,
  setSettingsTransportForTest,
  stopSettingsSubscription,
  type SettingsView,
} from "./settingsBridge";

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  stopSettingsSubscription();
  setSettingsTransportForTest(null);
  vi.restoreAllMocks();
});

describe("currentSettingsView", () => {
  it("is the default baseline before any diff has arrived", () => {
    installSettingsHarness();
    expect(currentSettingsView()).toEqual(DEFAULT_SETTINGS_VIEW);
  });

  it("reflects the region snapshot once subscribed", async () => {
    const doc = settingsDoc({ theme: "light", fontSize: 17 });
    installSettingsHarness(doc);
    const seen: SettingsView[] = [];
    onSettingsView((v) => seen.push(v));
    await ensureSettingsSubscribed();
    await flush();
    expect(currentSettingsView()).toEqual(doc);
    expect(seen[seen.length - 1]).toEqual(doc);
  });
});

describe("version guard", () => {
  it("ignores a stale (older-version) snapshot so it cannot clobber a newer view", async () => {
    const { transport } = installSettingsHarness(settingsDoc({ theme: "dark" }));
    const seen: SettingsView[] = [];
    onSettingsView((v) => seen.push(v));
    await ensureSettingsSubscribed();
    await flush();

    // A newer document lands…
    transport.seed(settingsDoc({ theme: "light" }));
    await flush();
    expect(currentSettingsView().theme).toBe("light");

    // …and a resync re-delivering an OLDER version is ignored (the client already
    // holds the newer one), so the view is not dragged back.
    expect(currentSettingsView().theme).toBe("light");
  });
});

describe("seedSettingsRegion (reliable dispatch)", () => {
  it("resolves once the region accepts the replace", async () => {
    installSettingsHarness();
    await expect(
      seedSettingsRegion(settingsDoc({ theme: "solarized-dark" }))
    ).resolves.toBeUndefined();
  });

  it("rejects when the ack is rejected", async () => {
    const rejecting: Transport = {
      async dispatch(intent: Intent): Promise<IntentAck> {
        return {
          intentId: intent.intentId,
          status: "rejected",
          error: { code: "rejected", message: "nope" },
        };
      },
      async subscribe() {
        return {
          snapshot: { kind: "snapshot", region: "settings", version: 0, view: {} },
          unsubscribe() {},
        };
      },
      async resync() {
        return null;
      },
    };
    setSettingsTransportForTest(rejecting);
    await expect(seedSettingsRegion(settingsDoc({ theme: "light" }))).rejects.toThrow("nope");
  });

  it("de-duplicates an identical document", async () => {
    const { transport } = installSettingsHarness();
    const doc = settingsDoc({ theme: "dark" });
    await seedSettingsRegion(doc);
    const replaces = () => transport.kinds().filter((k) => k === "settings.replace").length;
    const after = replaces();
    await seedSettingsRegion({ ...doc });
    expect(replaces()).toBe(after); // no second dispatch for identical content
  });
});

describe("FakeSettingsTransport", () => {
  it("folds settings.patch from the { patch } envelope (backend contract)", async () => {
    const transport = new FakeSettingsTransport();
    transport.seed(settingsDoc({ theme: "dark" }));
    await transport.dispatch({
      intentId: "1",
      clientId: "c",
      kind: "settings.patch",
      payload: { patch: { theme: "light" } },
    });
    expect(transport.regionView().theme).toBe("light");
  });
});
