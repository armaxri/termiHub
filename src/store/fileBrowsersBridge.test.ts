/**
 * File-browsers projection bridge (#2228 / #2283) — the authoritative region: a
 * `fileBrowser.*` mutation is overlaid on the projected view **synchronously**
 * (optimistic folding, #2533) and reconciled against the backend's diff, with no
 * appStore slice, no migration flag, and no faithful-mirror gate. Driven against an
 * in-memory substrate double that folds the granular intents like the Rust store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileEntry } from "@/types/connection";

import {
  currentFileBrowsersView,
  EMPTY_FILE_BROWSERS_VIEW,
  ensureFileBrowsersSubscribed,
  mirrorFileBrowserIntent,
  onFileBrowsersView,
  setFileBrowsersTransportForTest,
  stopFileBrowsersSubscription,
  type FileBrowsersView,
} from "./fileBrowsersBridge";
import { FakeFileBrowsersTransport, fileBrowsersView } from "@/test/fileBrowsersRegionTestHarness";

function entry(name: string, isDirectory = false): FileEntry {
  return {
    name,
    path: `/${name}`,
    isDirectory,
    size: 0,
    modified: "",
    permissions: null,
    writable: null,
    isSymlink: false,
    symlinkTarget: null,
  };
}

let transport: FakeFileBrowsersTransport;

beforeEach(() => {
  transport = new FakeFileBrowsersTransport();
  setFileBrowsersTransportForTest(transport);
});

afterEach(() => {
  stopFileBrowsersSubscription();
  setFileBrowsersTransportForTest(null);
});

const flush = () => Promise.resolve();

describe("mirrorFileBrowserIntent — optimistic folding", () => {
  it("overlays the active-pane switch synchronously", () => {
    mirrorFileBrowserIntent("fileBrowser.setMode", { mode: "local" });
    // No await: the overlay is applied to the projected view at once.
    expect(currentFileBrowsersView().mode).toBe("local");
  });

  it("overlays loading then the listing synchronously", () => {
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "local" });
    expect(currentFileBrowsersView().local.loading).toBe(true);

    mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
      pane: "local",
      path: "/home/user",
      entries: [entry("a"), entry("dir", true)],
    });
    const view = currentFileBrowsersView();
    expect(view.local.path).toBe("/home/user");
    expect(view.local.loading).toBe(false);
    expect(view.local.entries.map((e) => e.name)).toEqual(["a", "dir"]);
  });

  it("overlays a load failure synchronously", () => {
    mirrorFileBrowserIntent("fileBrowser.loadStarted", { pane: "session" });
    mirrorFileBrowserIntent("fileBrowser.loadFailed", { pane: "session", error: "denied" });
    const view = currentFileBrowsersView();
    expect(view.session.loading).toBe(false);
    expect(view.session.error).toBe("denied");
  });

  it("overlays the clipboard so a paste reads it right after a copy", () => {
    mirrorFileBrowserIntent("fileBrowser.setClipboard", {
      clipboard: { entries: [entry("c")], operation: "copy", sourceMode: "local", sourcePath: "/" },
    });
    expect(currentFileBrowsersView().clipboard?.operation).toBe("copy");
    mirrorFileBrowserIntent("fileBrowser.setClipboard", { clipboard: null });
    expect(currentFileBrowsersView().clipboard).toBeNull();
  });

  it("dispatches the intent to the backend and reconciles to the same view", async () => {
    mirrorFileBrowserIntent("fileBrowser.setMode", { mode: "session" });
    mirrorFileBrowserIntent("fileBrowser.loadSucceeded", {
      pane: "session",
      path: "/srv",
      entries: [entry("s")],
    });
    // The backend applied the same transitions…
    expect(transport.kinds()).toEqual(["fileBrowser.setMode", "fileBrowser.loadSucceeded"]);
    expect(transport.regionView().session.path).toBe("/srv");

    // …and once the subscription settles the authoritative view matches the overlay.
    await ensureFileBrowsersSubscribed();
    await flush();
    expect(currentFileBrowsersView()).toEqual(transport.regionView());
  });

  it("fans the projected view out to onFileBrowsersView listeners", () => {
    const seen: FileBrowsersView[] = [];
    const unsub = onFileBrowsersView((v) => seen.push(v));
    mirrorFileBrowserIntent("fileBrowser.setMode", { mode: "local" });
    unsub();
    expect(seen[seen.length - 1]?.mode).toBe("local");
  });

  it("swallows a rejected dispatch without throwing (resilience)", async () => {
    setFileBrowsersTransportForTest({
      dispatch: () =>
        Promise.resolve({
          intentId: "x",
          status: "rejected",
          error: { code: "rejected", message: "no" },
        }),
      subscribe: async (region, onFrame) => {
        void onFrame;
        return { snapshot: { kind: "snapshot", region, version: 0, view: {} }, unsubscribe() {} };
      },
      resync: async () => null,
    });
    // The overlay still applies; the rejection is logged, not thrown.
    expect(() => mirrorFileBrowserIntent("fileBrowser.setMode", { mode: "local" })).not.toThrow();
    await flush();
  });
});

describe("currentFileBrowsersView", () => {
  it("is the empty baseline before any mutation", () => {
    expect(currentFileBrowsersView()).toEqual(EMPTY_FILE_BROWSERS_VIEW);
  });

  it("seeds from a substrate snapshot on subscribe", async () => {
    transport.seed(fileBrowsersView({ mode: "local", local: { path: "/home", entries: [] } }));
    await ensureFileBrowsersSubscribed();
    await flush();
    expect(currentFileBrowsersView().mode).toBe("local");
    expect(currentFileBrowsersView().local.path).toBe("/home");
  });
});
