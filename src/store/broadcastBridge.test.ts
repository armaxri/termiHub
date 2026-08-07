/**
 * Broadcast-membership projection bridge (#2206) — the authoritative region.
 *
 * Drives the bridge against the in-memory {@link FakeBroadcastTransport} double
 * (folds the granular `broadcast.*` intents like the Rust store): a dispatched
 * intent round-trips into the fanned-out view and the cached
 * {@link currentBroadcastView}, with no appStore seed / mirror gate / flags (all
 * removed at the reducer removal).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installBroadcastHarness, type FakeBroadcastTransport } from "@/test/broadcastHarness";
import {
  currentBroadcastView,
  dispatchBroadcastIntent,
  dispatchBroadcastIntentBestEffort,
  EMPTY_BROADCAST_VIEW,
  ensureBroadcastSubscribed,
  onBroadcastView,
  type BroadcastView,
} from "./broadcastBridge";

let harness: ReturnType<typeof installBroadcastHarness>;
let transport: FakeBroadcastTransport;

beforeEach(() => {
  harness = installBroadcastHarness();
  transport = harness.transport;
});

afterEach(() => {
  harness.teardown();
});

describe("broadcast bridge — authoritative region", () => {
  it("reports the idle baseline before any diff", () => {
    expect(currentBroadcastView()).toEqual(EMPTY_BROADCAST_VIEW);
  });

  it("adopts the region snapshot on subscribe and fans it to listeners", async () => {
    transport.seed({
      active: true,
      sourceTabId: "src",
      scope: "panel",
      targetTabIds: ["src", "t1"],
    });
    const received: BroadcastView[] = [];
    onBroadcastView((v) => received.push(v));

    await ensureBroadcastSubscribed();

    expect(currentBroadcastView()).toMatchObject({
      active: true,
      sourceTabId: "src",
      scope: "panel",
      targetTabIds: ["src", "t1"],
    });
    expect(received[received.length - 1].targetTabIds).toEqual(["src", "t1"]);
  });

  it("round-trips a granular start intent into the projected view", async () => {
    await ensureBroadcastSubscribed();

    await dispatchBroadcastIntent("broadcast.start", {
      scope: "all",
      sourceTabId: "src",
      targetTabIds: ["t1", "t2"],
    });

    // The store reproduces {source} ∪ targets, source first.
    expect(currentBroadcastView()).toMatchObject({
      active: true,
      sourceTabId: "src",
      scope: "all",
      lastScope: "all",
      targetTabIds: ["src", "t1", "t2"],
    });
  });

  it("folds add/remove target intents in order", async () => {
    await ensureBroadcastSubscribed();
    await dispatchBroadcastIntent("broadcast.start", {
      scope: "all",
      sourceTabId: "src",
      targetTabIds: [],
    });

    dispatchBroadcastIntentBestEffort("broadcast.addTarget", { tabId: "t1" });
    dispatchBroadcastIntentBestEffort("broadcast.addTarget", { tabId: "t2" });
    dispatchBroadcastIntentBestEffort("broadcast.removeTarget", { tabId: "t1" });

    expect(new Set(currentBroadcastView().targetTabIds)).toEqual(new Set(["src", "t2"]));
    expect(transport.kinds()).toEqual([
      "broadcast.start",
      "broadcast.addTarget",
      "broadcast.addTarget",
      "broadcast.removeTarget",
    ]);
  });

  it("stop deactivates but retains scope / lastScope", async () => {
    await ensureBroadcastSubscribed();
    await dispatchBroadcastIntent("broadcast.start", {
      scope: "panel",
      sourceTabId: "src",
      targetTabIds: ["t1"],
    });
    await dispatchBroadcastIntent("broadcast.stop", {});

    const v = currentBroadcastView();
    expect(v.active).toBe(false);
    expect(v.sourceTabId).toBeNull();
    expect(v.targetTabIds).toEqual([]);
    expect(v.scope).toBe("panel");
    expect(v.lastScope).toBe("panel");
  });

  it("a best-effort dispatch never throws out of the caller", async () => {
    await ensureBroadcastSubscribed();
    expect(() => dispatchBroadcastIntentBestEffort("broadcast.stop", {})).not.toThrow();
  });
});
