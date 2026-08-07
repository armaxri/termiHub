/**
 * File-browsers projection bridge (#2228) — the render-cut flag, the
 * faithful-mirror gate, and the `fileBrowser.replace` whole-slice seed round-trip.
 * Drives the bridge against an in-memory substrate double that applies
 * `fileBrowser.replace` and fans a snapshot, without a backend.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  FrameHandler,
  Intent,
  IntentAck,
  ProjectionFrame,
  SnapshotFrame,
  Subscription,
  Transport,
} from "@/services/transport";
import type { FileEntry } from "@/types/connection";

import {
  currentFileBrowsersView,
  EMPTY_FILE_BROWSERS_VIEW,
  ensureFileBrowsersSubscribed,
  FILE_BROWSERS_REGION,
  fileBrowsersRenderFromProjectionEnabled,
  fileBrowsersViewMirrors,
  onFileBrowsersView,
  seedFileBrowsersRegion,
  setFileBrowsersRenderFromProjectionEnabled,
  setFileBrowsersTransportForTest,
  stopFileBrowsersSubscription,
  type FileBrowsersView,
} from "./fileBrowsersBridge";

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

function view(over: Partial<FileBrowsersView> = {}): FileBrowsersView {
  return {
    mode: "local",
    local: { path: "/home", entries: [entry("a")], loading: false, error: null },
    session: { path: "/", entries: [], loading: false, error: "gone" },
    clipboard: null,
    ...over,
  };
}

/** An in-memory substrate double: holds one file-browsers view, applies a
 * `fileBrowser.replace` by overwriting it, and fans a fresh snapshot to subscribers. */
class FakeTransport implements Transport {
  dispatched: Intent[] = [];
  private stored: FileBrowsersView = { ...EMPTY_FILE_BROWSERS_VIEW };
  private version = 0;
  private handlers: FrameHandler[] = [];

  async dispatch(intent: Intent): Promise<IntentAck> {
    this.dispatched.push(intent);
    if (intent.kind === "fileBrowser.replace") {
      this.stored = intent.payload as unknown as FileBrowsersView;
      this.version += 1;
      this.fan();
      return {
        intentId: intent.intentId,
        status: "accepted",
        produced: [{ region: FILE_BROWSERS_REGION, version: this.version }],
      };
    }
    return { intentId: intent.intentId, status: "accepted", produced: [] };
  }

  async subscribe(region: string, onFrame: FrameHandler): Promise<Subscription> {
    this.handlers.push(onFrame);
    return {
      snapshot: this.snapshot(region),
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== onFrame);
      },
    };
  }

  async resync(): Promise<SnapshotFrame | null> {
    return null;
  }

  private snapshot(region: string): SnapshotFrame {
    return { kind: "snapshot", region, version: this.version, view: structuredClone(this.stored) };
  }

  private fan(): void {
    const frame: ProjectionFrame = this.snapshot(FILE_BROWSERS_REGION);
    for (const h of this.handlers) h(frame);
  }
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  setFileBrowsersTransportForTest(transport);
});

afterEach(() => {
  stopFileBrowsersSubscription();
  setFileBrowsersTransportForTest(null);
  setFileBrowsersRenderFromProjectionEnabled(null);
});

describe("fileBrowsersRenderFromProjectionEnabled flag", () => {
  it("defaults on and honours the programmatic override", () => {
    expect(fileBrowsersRenderFromProjectionEnabled()).toBe(true);
    setFileBrowsersRenderFromProjectionEnabled(false);
    expect(fileBrowsersRenderFromProjectionEnabled()).toBe(false);
    setFileBrowsersRenderFromProjectionEnabled(true);
    expect(fileBrowsersRenderFromProjectionEnabled()).toBe(true);
    setFileBrowsersRenderFromProjectionEnabled(null);
    expect(fileBrowsersRenderFromProjectionEnabled()).toBe(true);
  });
});

describe("fileBrowsersViewMirrors gate", () => {
  it("is false for an undefined view", () => {
    expect(fileBrowsersViewMirrors(undefined, view())).toBe(false);
  });

  it("mirrors when the whole view matches by value", () => {
    expect(fileBrowsersViewMirrors(view(), view())).toBe(true);
  });

  it("rejects on any field divergence", () => {
    expect(fileBrowsersViewMirrors(view({ mode: "session" }), view())).toBe(false);
    expect(
      fileBrowsersViewMirrors(
        view({ local: { path: "/x", entries: [], loading: false, error: null } }),
        view()
      )
    ).toBe(false);
    // A different listing under the same pane path is not a mirror.
    expect(
      fileBrowsersViewMirrors(
        view({
          session: { path: "/", entries: [entry("other", true)], loading: false, error: "gone" },
        }),
        view()
      )
    ).toBe(false);
    // A divergent clipboard is not a mirror.
    expect(
      fileBrowsersViewMirrors(
        view({
          clipboard: {
            entries: [entry("c")],
            operation: "copy",
            sourceMode: "local",
            sourcePath: "/home",
          },
        }),
        view()
      )
    ).toBe(false);
  });
});

describe("seedFileBrowsersRegion (fileBrowser.replace mirror)", () => {
  it("dispatches a fileBrowser.replace and fans the mirrored view", async () => {
    const received: FileBrowsersView[] = [];
    onFileBrowsersView((v) => received.push(v));
    await ensureFileBrowsersSubscribed();

    const v = view();
    await seedFileBrowsersRegion(v);

    const replace = transport.dispatched.filter((d) => d.kind === "fileBrowser.replace");
    expect(replace).toHaveLength(1);
    expect(currentFileBrowsersView()).toEqual(v);
    expect(received[received.length - 1]).toEqual(v);
  });

  it("de-duplicates an identical seed", async () => {
    await ensureFileBrowsersSubscribed();
    const v = view();
    await seedFileBrowsersRegion(v);
    await seedFileBrowsersRegion(v);
    expect(transport.dispatched.filter((d) => d.kind === "fileBrowser.replace")).toHaveLength(1);
  });
});
